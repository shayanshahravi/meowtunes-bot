import { MeowTunesClient, VaslFile } from './client';

export interface ArtistTrackSummary {
  /** Opaque per-search index, used in callback_data (never raw fileId in UI text). */
  resultId: string;
  fileId: string;
  title: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  coverUrl?: string;
}

/**
 * Artist search adapter — normalizes the REAL music search response into
 * ArtistTrackSummary[]. No endpoint strings here; they live in contract.ts.
 *
 * fileId is taken verbatim from VaslFile._id (or .id fallback) — never inferred.
 */
export class ArtistSearchService {
  constructor(private readonly client: MeowTunesClient) {}

  async search(query: string, limit = 8): Promise<ArtistTrackSummary[]> {
    const { songs } = await this.client.searchMusic(query, { limit });
    const out: ArtistTrackSummary[] = [];
    for (let i = 0; i < songs.length && out.length < limit; i++) {
      const s: VaslFile = songs[i];
      const fileId = String((s as any)._id ?? (s as any).id ?? '').trim();
      if (!fileId) continue; // per spec: skip rows lacking a real fileId
      const meta = (s as any).audioMetadata ?? {};
      out.push({
        resultId: String(i),
        fileId,
        title: String(meta.title ?? (s as any).name ?? (s as any).originalName ?? 'Untitled'),
        artist: meta.artist ? String(meta.artist) : undefined,
        album: meta.album ? String(meta.album) : undefined,
        durationSec: (s as any).durationSec ?? meta.duration ?? undefined,
        coverUrl: (s as any).thumbnail ?? (s as any).coverUrl ?? meta.artwork ?? undefined,
      });
    }
    return out;
  }

  /** Re-resolve a stored summary back into the canonical VaslFile for TrackResolver. */
  toVaslFile(t: ArtistTrackSummary): VaslFile {
    return {
      _id: t.fileId,
      id: t.fileId,
      name: t.title,
      audioMetadata: { title: t.title, artist: t.artist, album: t.album, artwork: t.coverUrl },
      thumbnail: t.coverUrl,
    } as VaslFile;
  }
}
