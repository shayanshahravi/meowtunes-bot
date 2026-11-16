/**
 * Worker-compatible MeowTunes client.
 * No Node builtins — only fetch + Web APIs.
 * Contract is the single source of truth for paths.
 */

import { MeowTunesContract, fillPath } from '../meowtunes/contract';
import type { VaslFile } from '../meowtunes/client';
import type { WorkerConfig, WorkerLogger } from './env';

class WorkerMeowError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'WorkerMeowError';
  }
  static notFound(r: string) {
    return new WorkerMeowError(`${r} not found`, 'NOT_FOUND', 404, false);
  }
  static invalidMedia(m: string) {
    return new WorkerMeowError(m, 'INVALID_MEDIA', 400, false);
  }
  static transient(m: string) {
    return new WorkerMeowError(m, 'TRANSIENT', undefined, true);
  }
  static internal(m: string) {
    return new WorkerMeowError(m, 'INTERNAL', 500, true);
  }
  static rateLimited(ra?: number) {
    const e = new WorkerMeowError('Rate limited', 'RATE_LIMITED', 429, true);
    (e as unknown as Record<string, unknown>).retryAfter = ra;
    return e;
  }
}

function assertAllowedHost(raw: string, baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw WorkerMeowError.invalidMedia('Malformed API URL');
  }
  if (parsed.protocol !== 'https:') throw new WorkerMeowError('Only https endpoints allowed', 'SSRF_BLOCKED');
  const allowed = new URL(baseUrl);
  if (parsed.host !== allowed.host) throw new WorkerMeowError(`Outbound host not allowed: ${parsed.host}`, 'SSRF_BLOCKED');
}

async function workerFetch(
  cfg: WorkerConfig,
  log: WorkerLogger,
  path: string,
  params?: Record<string, string | number | undefined>,
  opts: { method?: string; body?: unknown; raw?: boolean; timeoutMs?: number; maxRetries?: number } = {},
): Promise<{ status: number; headers: Record<string, string>; data: unknown; rawBytes?: Uint8Array }> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const url = new URL(base + (path.startsWith('/') ? path : `/${path}`));
  assertAllowedHost(url.toString(), cfg.baseUrl);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));

  const maxRetries = opts.maxRetries ?? cfg.maxRetries;
  let last: WorkerMeowError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? cfg.requestTimeoutMs);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (cfg.meowtunesToken) headers['Authorization'] = `Bearer ${cfg.meowtunesToken}`;
      const hasBody = opts.body !== undefined;
      if (hasBody) headers['Content-Type'] = 'application/json';
      const resp = await fetch(url.toString(), {
        method: opts.method ?? 'GET',
        headers,
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
      const rh: Record<string, string> = {};
      resp.headers.forEach((v, k) => { rh[k.toLowerCase()] = v; });

      if (!resp.ok) {
        const cls = classify(resp.status, rh);
        if (!cls.retryable || attempt === maxRetries) throw cls;
        last = cls;
        log.warn('retryable http error', { path, status: resp.status, attempt: attempt + 1 });
        await backoff(attempt, cls);
        continue;
      }

      if (opts.raw) {
        const ab = await resp.arrayBuffer();
        const bytes = new Uint8Array(ab);
        return { status: resp.status, headers: rh, data: bytes, rawBytes: bytes };
      }

      const ct = rh['content-type'] || '';
      if (ct.includes('text/html')) {
        throw new WorkerMeowError(
          `API base URL returned SPA shell HTML for ${path} — base URL likely needs /api prefix`,
          'SPA_FALLBACK',
          resp.status,
          false,
        );
      }
      const txt = await resp.text();
      let data: unknown = null;
      try {
        data = txt ? (JSON.parse(txt) as unknown) : null;
      } catch {
        throw WorkerMeowError.invalidMedia(`Non-JSON response from ${path}`);
      }
      return { status: resp.status, headers: rh, data };
    } catch (err) {
      if (err instanceof WorkerMeowError) {
        if (!err.retryable || attempt === maxRetries) throw err;
        last = err;
        await backoff(attempt, err);
        continue;
      }
      const isAbort = (err as Error)?.name === 'AbortError';
      const w = new WorkerMeowError(isAbort ? 'Request timed out' : `Network error: ${(err as Error).message}`, isAbort ? 'TIMEOUT' : 'NETWORK', undefined, true);
      if (attempt === maxRetries) throw w;
      last = w;
      await backoff(attempt, w);
    } finally {
      clearTimeout(t);
    }
  }
  throw last ?? WorkerMeowError.internal('Request failed');
}

function classify(status: number, headers: Record<string, string>): WorkerMeowError {
  if (status === 401) return new WorkerMeowError('Authentication failed or token expired', 'UNAUTHORIZED', 401, false);
  if (status === 403) return new WorkerMeowError('Not permitted for this account', 'UNAUTHORIZED', 403, false);
  if (status === 404) return WorkerMeowError.notFound('Resource');
  if (status === 429) return WorkerMeowError.rateLimited(parseInt(headers['retry-after'] || '5', 10));
  if (status >= 500) return new WorkerMeowError(`Upstream error ${status}`, 'TRANSIENT', status, true);
  if (status === 400 || status === 422) return WorkerMeowError.invalidMedia(`Request rejected (${status})`);
  return new WorkerMeowError(`HTTP ${status}`, 'UNKNOWN', status, false);
}

async function backoff(attempt: number, err: WorkerMeowError): Promise<void> {
  const ra = (err as unknown as { retryAfter?: number }).retryAfter;
  const d = typeof ra === 'number' && Number.isFinite(ra) ? ra * 1000 : Math.min(1500 * 2 ** attempt, 8000);
  await new Promise<void>((r) => setTimeout(r, d));
}

export class WorkerMeowClient {
  constructor(
    private readonly cfg: WorkerConfig,
    private readonly log: WorkerLogger,
  ) {}

  async getSession(): Promise<{ ok: boolean; role: string; isSuperAdmin: boolean }> {
    const { data } = await workerFetch(this.cfg, this.log, MeowTunesContract.auth.session.path);
    const user = (data as Record<string, unknown>)?.['user'] ?? data;
    if (user && typeof user === 'object') {
      const u = user as Record<string, unknown>;
      const role = (u['role'] as string) || 'user';
      const isSuperAdmin = u['isSuperAdmin'] === true;
      if (role === 'user' || role === 'admin') return { ok: true, role, isSuperAdmin };
    }
    const legacy = data as Record<string, unknown>;
    if (legacy?.['ok']) {
      const role = (legacy['role'] as string) || 'user';
      const isSuper = legacy['isSuperAdmin'] === true;
      if (role === 'user' || role === 'admin') return { ok: true, role, isSuperAdmin: isSuper };
    }
    return { ok: false, role: 'user', isSuperAdmin: false };
  }

  async searchPlaylists(query: string, pos = 0): Promise<{ playlists: Array<Record<string, unknown>> }> {
    const c = MeowTunesContract.playlists.search;
    const { data } = await workerFetch(this.cfg, this.log, c.path, { q: query, pos });
    if (!data) throw WorkerMeowError.notFound('search results');
    return { playlists: ((data as Record<string, unknown>)['playlists'] as Array<Record<string, unknown>>) ?? [] };
  }

  async getPlaylist(id: string): Promise<{ playlist: Record<string, unknown>; songs: VaslFile[] }> {
    const p = fillPath(MeowTunesContract.playlists.get.path, { id });
    const { data } = await workerFetch(this.cfg, this.log, p);
    if (!data) throw WorkerMeowError.notFound('playlist');
    const payload = (data as Record<string, unknown>)['playlist'] ? (data as Record<string, unknown>) : ({ playlist: data, songs: (data as Record<string, unknown>)['songs'] } as Record<string, unknown>);
    const playlist = (payload['playlist'] as Record<string, unknown>) ?? (payload as Record<string, unknown>);
    const songs = (payload['songs'] as VaslFile[]) ?? ((playlist as Record<string, unknown>)['songs'] as VaslFile[]) ?? [];
    return { playlist, songs: Array.isArray(songs) ? songs : [] };
  }

  async getPublicPlaylist(ownerUserId: string, playlistId: string): Promise<{ playlist: Record<string, unknown>; songs: VaslFile[] }> {
    const p = fillPath(MeowTunesContract.playlists.public.path, { ownerUserId, playlistId });
    const { data } = await workerFetch(this.cfg, this.log, p);
    if (!data) throw WorkerMeowError.notFound('public playlist');
    const payload = (data as Record<string, unknown>)['playlist'] ? (data as Record<string, unknown>) : ({ playlist: data, songs: (data as Record<string, unknown>)['songs'] } as Record<string, unknown>);
    const playlist = (payload['playlist'] as Record<string, unknown>) ?? (payload as Record<string, unknown>);
    const songs = (payload['songs'] as VaslFile[]) ?? ((playlist as Record<string, unknown>)['songs'] as VaslFile[]) ?? [];
    return { playlist, songs: Array.isArray(songs) ? songs : [] };
  }

  async getFile(fileId: string): Promise<VaslFile> {
    const p = fillPath(MeowTunesContract.files.get.path, { id: fileId });
    const { data } = await workerFetch(this.cfg, this.log, p);
    if (!data) throw WorkerMeowError.notFound('file');
    return ((data as Record<string, unknown>)['file'] as VaslFile) ?? (data as VaslFile);
  }

  async searchMusic(query: string, opts: { limit?: number; page?: number } = {}): Promise<{ songs: VaslFile[]; total?: number; hasMore?: boolean }> {
    const c = MeowTunesContract.music.search;
    const params: Record<string, string | number | undefined> = { q: query };
    if (opts.limit !== undefined) params['limit'] = opts.limit;
    if (opts.page !== undefined) params['page'] = opts.page;
    const { data } = await workerFetch(this.cfg, this.log, c.path, params);
    if (!data) return { songs: [] };
    const d = data as Record<string, unknown>;
    const songs = (d['songs'] as VaslFile[]) ?? (d['results'] as VaslFile[]) ?? (Array.isArray(data) ? (data as VaslFile[]) : []);
    const total = (d['pagination'] as Record<string, unknown>)?.['total'] as number | undefined ?? (d['total'] as number | undefined);
    const hasMore = typeof total === 'number' ? (Array.isArray(songs) ? songs.length : 0) < total : undefined;
    return { songs: Array.isArray(songs) ? songs : [], total, hasMore };
  }

  async getFileSourceBytes(fileId: string, slide = 0): Promise<{ bytes: Uint8Array; contentType: string }> {
    const p = fillPath(MeowTunesContract.files.source.path, { id: fileId });
    const { headers, rawBytes } = await workerFetch(this.cfg, this.log, p, { slide }, { raw: true });
    const bytes = rawBytes ?? new Uint8Array();
    if (bytes.length === 0) throw WorkerMeowError.invalidMedia('Empty download');
    if (bytes.length > this.cfg.maxFileSizeBytes) throw WorkerMeowError.invalidMedia(`File too large: ${bytes.length} > ${this.cfg.maxFileSizeBytes}`);
    return { bytes, contentType: headers['content-type'] || 'application/octet-stream' };
  }
}

export { WorkerMeowError };
