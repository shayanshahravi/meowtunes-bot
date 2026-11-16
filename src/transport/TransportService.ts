import { Logger } from '../logging/logger';
import { MeowTunesError } from '../utils/errors';
import { config } from '../config';

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  params?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
  responseType?: 'json' | 'arraybuffer' | 'stream';
  /** Return raw bytes instead of parsed JSON (used by download). */
  raw?: boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
}

export interface TransportService {
  request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>>;
  readonly name: string;
}

/**
 * Hard allowlist: the bot only ever talks to the configured MeowTunes API host.
 * This is the primary SSRF control — no user-supplied URL is ever fetched.
 */
function assertAllowedHost(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw MeowTunesError.invalidMedia(`Malformed API URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new MeowTunesError('Only https API endpoints are permitted', 'SSRF_BLOCKED');
  }
  const allowed = new URL(config.meowtunes.baseUrl);
  if (parsed.host !== allowed.host) {
    throw new MeowTunesError(`Outbound host not allowed: ${parsed.host}`, 'SSRF_BLOCKED');
  }
}

export class DirectTransport implements TransportService {
  readonly name = 'direct';

  constructor(private readonly logger: Logger) {}

  async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    const base = config.meowtunes.baseUrl.replace(/\/+$/, '');
    const url = new URL(base + (options.path.startsWith('/') ? options.path : `/${options.path}`));
    assertAllowedHost(url.toString());

    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }

    const maxRetries = options.maxRetries ?? config.download.maxRetries;
    let lastError: MeowTunesError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? config.download.requestTimeoutMs
      );
      try {
        const headers: Record<string, string> = {
          Accept: 'application/json',
          ...options.headers,
        };
        if (config.meowtunes.token) {
          headers['Authorization'] = `Bearer ${config.meowtunes.token}`;
        }
        if (options.body !== undefined && headers['Content-Type'] === undefined) {
          headers['Content-Type'] = 'application/json';
        }

        const response = await fetch(url.toString(), {
          method: options.method ?? 'GET',
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });

        const respHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          respHeaders[k.toLowerCase()] = v;
        });

        if (!response.ok) {
          const classified = this.classify(response.status, respHeaders);
          // Auth errors and 404 are terminal: never retried.
          if (!classified.retryable || attempt === maxRetries) throw classified;
          lastError = classified;
          this.logger.warn('retryable http error', {
            path: options.path,
            status: response.status,
            attempt: attempt + 1,
          });
          await this.backoff(attempt, classified);
          continue;
        }

        let data: unknown;
        const contentType = respHeaders['content-type'] || '';
        if (options.raw || options.responseType === 'arraybuffer') {
          const buf = Buffer.from(await response.arrayBuffer());
          data = buf;
        } else if (options.responseType === 'stream') {
          data = Buffer.from(await response.arrayBuffer());
        } else if (contentType.includes('text/html')) {
          // The edge/CDN serves the SPA shell for unknown paths. Treat as a
          // misconfigured base URL rather than a successful API response.
          throw new MeowTunesError(
            `API base URL returned the SPA shell (HTML) for ${options.path} — the base URL likely needs the /api prefix and/or internal port`,
            'SPA_FALLBACK',
            response.status,
            false
          );
        } else {
          const text = await response.text();
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            throw MeowTunesError.invalidMedia(`Non-JSON response from ${options.path}`);
          }
        }

        return { status: response.status, headers: respHeaders, data: data as T };
      } catch (err) {
        if (err instanceof MeowTunesError) {
          if (!err.retryable || attempt === maxRetries) throw err;
          lastError = err;
          await this.backoff(attempt, err);
          continue;
        }
        const isAbort = (err as Error)?.name === 'AbortError';
        const wrapped = new MeowTunesError(
          isAbort ? 'Request timed out' : `Network error: ${(err as Error).message}`,
          isAbort ? 'TIMEOUT' : 'NETWORK',
          undefined,
          true
        );
        if (attempt === maxRetries) throw wrapped;
        lastError = wrapped;
        await this.backoff(attempt, wrapped);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? MeowTunesError.internal('Request failed');
  }

  private classify(status: number, headers: Record<string, string>): MeowTunesError {
    if (status === 401) {
      return new MeowTunesError('Authentication failed or token expired', 'UNAUTHORIZED', 401, false);
    }
    if (status === 403) return MeowTunesError.unauthorized('Not permitted for this account');
    if (status === 404) return MeowTunesError.notFound('Resource');
    if (status === 429) {
      const ra = parseInt(headers['retry-after'] || '5', 10);
      const err = MeowTunesError.rateLimited(ra);
      return err;
    }
    if (status >= 500) return new MeowTunesError(`Upstream error ${status}`, 'TRANSIENT', status, true);
    if (status === 400 || status === 422)
      return MeowTunesError.invalidMedia(`Request rejected (${status})`);
    return new MeowTunesError(`HTTP ${status}`, 'UNKNOWN', status, false);
  }

  private async backoff(attempt: number, err: MeowTunesError): Promise<void> {
    const retryAfter = (err as any).retryAfter as number | undefined;
    const delay = retryAfter ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 15000);
    await new Promise((r) => setTimeout(r, delay));
  }
}
