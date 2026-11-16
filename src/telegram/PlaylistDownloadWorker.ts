import { TrackJob, TrackJobForPlaylist, TrackJobStatus } from '../queue/jobs';
import { QueueManager } from '../queue/QueueManager';
import { MeowTunesDownloadService, DownloadResult } from '../meowtunes/download';
import { TrackResolver } from '../meowtunes/tracks';
import { TelegramService } from './TelegramService';
import { TelegramProgress } from './TelegramProgress';
import { Logger, logger } from '../logging/logger';

export class PlaylistDownloadWorker {
  constructor(
    private readonly downloader: MeowTunesDownloadService,
    private readonly trackResolver: TrackResolver,
    private readonly telegram: TelegramService,
    private readonly progress: TelegramProgress,
    private readonly log: Logger = logger
  ) {}

  /**
   * Process a playlist: enqueue tracks, run queue, report final summary.
   */
  async processPlaylist(params: {
    chatId: number;
    telegramUserId: number;
    playlistId: string;
    playlistTitle: string;
    tracks: Array<{ trackId: string; fileId: string; title: string; artist?: string; album?: string }>;
  }): Promise<TrackJob> {
    const job: TrackJob = {
      jobId: `job_${Date.now()}`,
      telegramUserId: params.telegramUserId,
      playlistId: params.playlistId,
      playlistTitle: params.playlistTitle,
      totalTracks: params.tracks.length,
      completedTracks: 0,
      failedTracks: 0,
      cancelledTracks: 0,
      status: TrackJobStatus.QUEUED,
      tracks: [],
    };

    const trackJobs: TrackJobForPlaylist[] = params.tracks.map((t, i) => ({
      jobId: `track_${job.jobId}_${i}`,
      trackId: t.trackId,
      songId: t.trackId,
      fileId: t.fileId,
      title: t.title,
      artist: t.artist,
      album: t.album,
      status: TrackJobStatus.QUEUED,
      retryCount: 0,
    }));

    job.tracks = trackJobs;

    const queue = new QueueManager();
    this.progress.push(job, null);

    queue.onProgress((updatedJob, current) => {
      this.progress.push(updatedJob, current).catch(() => {});
    });

    queue.enqueue({
      jobId: job.jobId,
      telegramUserId: params.telegramUserId,
      playlistId: params.playlistId,
      playlistTitle: params.playlistTitle,
      totalTracks: params.tracks.length,
      completedTracks: 0,
      failedTracks: 0,
      cancelledTracks: 0,
      status: TrackJobStatus.QUEUED,
      tracks: trackJobs,
    });

    await queue.start(async (track) => {
      track.status = TrackJobStatus.DOWNLOADING;
      let result: DownloadResult | undefined;
      try {
        result = await this.downloader.download(track.fileId);
        const caption = `<b>🎵 ${track.title}</b>${track.artist ? `\n👤 ${track.artist}` : ''}${track.album ? `\n💿 ${track.album}` : ''}`;

        try {
          await this.telegram.uploadAudio(
            params.chatId,
            result.filePath,
            caption,
            track.title,
            track.artist,
            track.album
          );
        } catch {
          await this.telegram.uploadDocument(params.chatId, result.filePath, caption);
        }

        await result.cleanup();
      } catch (err: any) {
        this.log.warn('track failed', { trackId: track.trackId, error: err.message });
        await result?.cleanup().catch(() => {});
        throw err;
      }
    });

    return job;
  }
}
