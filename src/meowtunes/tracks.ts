import { Logger, logger } from '../logging/logger';
import { MeowTunesError } from '../utils/errors';
import { TrackJobForPlaylist, TrackJobStatus } from '../queue/jobs';
import type { VaslFile } from './client';

/**
 * TrackResolver — explicitly resolves fileId.
 *
 * Evidence from bundle: playlist.songs IS VaslFile[] (see VaslMusic handleSelection /
 * playPlaylist: we(Ce,Q) where Ce = playlist.songs). VaslFile._id IS the fileId used
 * by getFileSource / audio playback. No extra lookup endpoint is needed.
 *
 * Invariant: downloader MUST receive fileId (VaslFile._id), never a synthetic trackId.
 */
export class TrackResolver {
  constructor(private readonly log: Logger = logger) {}

  /** Resolve fileId for one VaslFile. Never guesses — requires _id/id. */
  async resolveFileId(song: VaslFile): Promise<string> {
    const fileId = String((song as any)._id ?? (song as any).id ?? '').trim();
    if (!fileId) {
      throw new MeowTunesError(
        `Cannot resolve fileId for song "${(song as any).name ?? (song as any).audioMetadata?.title ?? 'unknown'}" — missing _id/id`,
        'FILE_NOT_RESOLVED',
        undefined,
        false
      );
    }
    this.log.debug('fileId resolved from VaslFile._id', { songId: fileId, fileId });
    return fileId;
  }

  titleOf(s: VaslFile): string {
    return String((s as any).audioMetadata?.title ?? (s as any).name ?? (s as any).originalName ?? (s as any)._id ?? 'Untitled');
  }
  artistOf(s: VaslFile): string | undefined {
    const a = (s as any).audioMetadata?.artist ?? (s as any).uploader?.displayName;
    return a ? String(a) : undefined;
  }
  albumOf(s: VaslFile): string | undefined {
    const a = (s as any).audioMetadata?.album;
    return a ? String(a) : undefined;
  }

  async buildTrackJob(song: VaslFile, playlistId: string, _playlistTitle: string, _index: number): Promise<TrackJobForPlaylist> {
    const fileId = await this.resolveFileId(song);
    const title = this.titleOf(song);
    return {
      trackId: fileId,
      songId: fileId,
      fileId,
      title,
      artist: this.artistOf(song),
      album: this.albumOf(song),
      status: TrackJobStatus.QUEUED,
      retryCount: 0,
    };
  }
}
