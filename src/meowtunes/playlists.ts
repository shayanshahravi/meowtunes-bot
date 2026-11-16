import { MeowTunesClient, VaslFile } from './client';

export interface PlaylistSummary {
  id: string;
  title: string;
  ownerId: string;
  songCount: number;
  privacy: string;
  coverUrl?: string;
  isOwner?: boolean;
}

/**
 * Thin adapter over MeowTunesClient — no endpoint strings here.
 */
export class PlaylistService {
  constructor(private readonly client: MeowTunesClient) {}

  async search(name: string): Promise<PlaylistSummary[]> {
    const { playlists } = await this.client.searchPlaylists(name);
    return playlists.map((p: any) => ({
      id: String(p._id ?? p.id),
      title: String(p.name ?? p.title ?? ''),
      ownerId: String(p.owner?.userId ?? p.ownerId ?? p.ownerUserId ?? ''),
      songCount: Number(p.songCount ?? p.songsCount ?? (Array.isArray(p.songs) ? p.songs.length : 0)),
      privacy: p.isPublic === false ? 'private' : 'public',
      coverUrl: p.coverUrl ?? p.thumbnail ?? undefined,
      isOwner: Boolean(p.isOwner ?? p.owner?.self),
    }));
  }

  async resolve(id: string): Promise<{ playlistId: string; playlistTitle: string; songs: VaslFile[] }> {
    const { playlist, songs } = await this.client.getPlaylist(id);
    const playlistId = String(playlist._id ?? playlist.id ?? id);
    const playlistTitle = String(playlist.name ?? playlist.title ?? '');
    return { playlistId, playlistTitle, songs: songs ?? [] };
  }
}
