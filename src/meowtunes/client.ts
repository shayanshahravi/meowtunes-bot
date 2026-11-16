import { TransportService } from '../transport/TransportService';
import { createTransport } from '../transport/factory';
import { Logger, logger } from '../logging/logger';
import { MeowTunesError } from '../utils/errors';
import { MeowTunesContract, fillPath } from './contract';

export interface MeowTunesAuthResponse {
  ok: boolean;
  role: 'user' | 'admin';
  isSuperAdmin?: boolean;
}

/** Backend shape for GET /auth/session — see body.txt / main.js checkSession */
interface SessionResponse {
  user?: { role?: string; isSuperAdmin?: boolean };
  ok?: boolean;
  role?: string;
  isSuperAdmin?: boolean;
}

/**
 * VaslFile = canonical media object the frontend uses as "song".
 * Evidence: main.js: yt.getFile => /files/:id, getFileSource => /files/:id/source,
 * VaslMusic D1/_ uses n._id||n.id and audioMetadata.title/artist.
 * Playlist songs are VaslFile[] — therefore fileId IS the VaslFile _id.
 */
export interface VaslFile {
  _id: string;
  id?: string;
  name?: string;
  originalName?: string;
  mimeType?: string;
  size?: number;
  audioMetadata?: { title?: string; artist?: string; album?: string; artwork?: string };
  uploader?: { displayName?: string };
  // fallback fields some code paths use
  filename?: string;
  thumbnail?: string;
}

/**
 * MeowTunes client: SINGLE source of truth for the verified API contract.
 * All endpoint strings come from MeowTunesContract — never hardcode elsewhere.
 */
export class MeowTunesClient {
  readonly transport: TransportService;

  constructor(private readonly log: Logger = logger) {
    this.transport = createTransport();
  }

  async getSession(): Promise<MeowTunesAuthResponse> {
    const { data } = await this.transport.request<SessionResponse>({
      path: MeowTunesContract.auth.session.path,
    });
    // Server returns { user: { role, isSuperAdmin } } — see main.js checkSession: e?.data?.user?.role
    const user = (data as any)?.user ?? data;
    if (user) {
      const role = ((user as any).role || 'user') as 'user' | 'admin';
      const isSuperAdmin = (user as any).isSuperAdmin === true;
      if (role === 'user' || role === 'admin') return { ok: true, role, isSuperAdmin };
    }
    // Fallback legacy shape { ok, role, isSuperAdmin }
    if ((data as any)?.ok) {
      const role = ((data as any).role || 'user') as 'user' | 'admin';
      const isSuperAdmin = (data as any).isSuperAdmin === true;
      if (role === 'user' || role === 'admin') return { ok: true, role, isSuperAdmin };
    }
    return { ok: false, role: 'user', isSuperAdmin: false };
  }

  async searchPlaylists(
    query: string,
    pos = 0
  ): Promise<{ playlists: Array<{ _id: string; id?: string; name: string; ownerId?: string; owner?: any; songCount: number; isPublic?: boolean; coverUrl?: string }> }> {
    const c = MeowTunesContract.playlists.search;
    // Evidence: Pt.searchPlaylists: x.get("/music/playlists/search", {params:{q:e,...t}})
    const { data } = await this.transport.request<any>({ path: c.path, params: { q: query, pos } });
    if (!data) throw MeowTunesError.notFound('search results');
    // Server returns { playlists: [...] } — normalize empty too
    return { playlists: (data as any).playlists ?? [] };
  }

  async getPlaylist(id: string): Promise<{ playlist: any; songs: VaslFile[] }> {
    // Evidence: Pt.getPlaylist: x.get(`/music/playlists/${e}`)
    // Handler in VaslMusic: (await Pt.getPlaylist(L)).data.playlist.songs — songs IS VaslFile[]
    const p = fillPath(MeowTunesContract.playlists.get.path, { id });
    const { data } = await this.transport.request<any>({ path: p });
    if (!data) throw MeowTunesError.notFound('playlist');
    // Axios wraps as { data: { playlist, songs? } } OR directly { playlist }
    const payload = (data as any).playlist ? (data as any) : { playlist: (data as any), songs: (data as any).songs };
    const playlist = (payload as any).playlist ?? payload;
    const songs: VaslFile[] = (payload as any).songs ?? (playlist as any).songs ?? [];
    // Some responses nest under .data.playlist when using raw fetch wrappers — already handled
    return { playlist, songs };
  }

  async getFile(fileId: string): Promise<VaslFile> {
    // Evidence: yt.getFile: x.get(`/files/${e}`) — file detail
    const p = fillPath(MeowTunesContract.files.get.path, { id: fileId });
    const { data } = await this.transport.request<any>({ path: p });
    if (!data) throw MeowTunesError.notFound('file');
    // Unwrap { file } or direct
    return ((data as any).file ?? data) as VaslFile;
  }

  /**
   * Real music search — never invented.
   * Evidence: main.js: searchMusic -> GET music search with q param (see contract)
   * Generic music search (title + artist + album), not artist-only on server.
   * /artist command narrows presentation-side; server filters by q substring match.
   */
  async searchMusic(
    query: string,
    opts: { limit?: number; page?: number } = {}
  ): Promise<{ songs: VaslFile[]; total?: number; hasMore?: boolean }> {
    const c = MeowTunesContract.music.search;
    const { data } = await this.transport.request<any>({
      path: c.path,
      params: { q: query, ...(opts.limit !== undefined ? { limit: opts.limit } : {}), ...(opts.page !== undefined ? { page: opts.page } : {}) },
    });
    if (!data) return { songs: [] };
    // Observed shapes: { songs: VaslFile[], pagination? } or { results: ... } — handle both
    const songs: VaslFile[] = (data as any).songs ?? (data as any).results ?? (Array.isArray(data) ? (data as any) : []);
    const total: number | undefined = (data as any).pagination?.total ?? (data as any).total;
    const hasMore = typeof total === 'number' ? songs.length < total : undefined;
    return { songs: Array.isArray(songs) ? songs : [], total, hasMore };
  }

}