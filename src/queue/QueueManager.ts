import { Logger, logger } from '../logging/logger';
import { config } from '../config';
import { TrackJob, TrackJobStatus, TrackJobForPlaylist } from './jobs';

export type JobProgressCallback = (
  job: TrackJob,
  current: TrackJobForPlaylist | null
) => void;

export class QueueManager {
  private activeDownloads = 0;
  private queue: TrackJobForPlaylist[] = [];
  private currentJob: TrackJob | null = null;
  private cancelled = false;
  private readonly listeners: Set<JobProgressCallback> = new Set();

  constructor(private readonly log: Logger = logger) {}

  getStatus(): TrackJob | null {
    return this.currentJob;
  }

  getQueue(): TrackJobForPlaylist[] {
    return [...this.queue];
  }

  onProgress(cb: JobProgressCallback): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(job: TrackJob, current: TrackJobForPlaylist | null): void {
    for (const cb of this.listeners) cb(job, current);
  }

  /**
   * Create and enqueue a playlist job. Returns the job object.
   */
  enqueue(params: Omit<TrackJob, 'tracks'> & { tracks: TrackJobForPlaylist[] }): TrackJob {
    const job: TrackJob = {
      ...params,
      tracks: params.tracks,
    };
    // Reset statuses for queued tracks
    for (const t of job.tracks) {
      t.status = TrackJobStatus.QUEUED;
    }
    this.queue.push(...job.tracks);
    this.currentJob = job;
    this.emit(job, null);
    return job;
  }

  /**
   * Start processing the queue. Resolves with the final job summary.
   */
  async start(
    processor: (track: TrackJobForPlaylist) => Promise<void>
  ): Promise<TrackJob> {
    if (!this.currentJob) throw new Error('No job enqueued');
    const job = this.currentJob;
    job.status = TrackJobStatus.QUEUED;

    const run = async (): Promise<void> => {
      while (this.queue.length > 0 && !this.cancelled) {
        // Respect max concurrency
        while (this.activeDownloads >= config.download.maxConcurrent) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const track = this.queue.shift()!;
        if (!track) break;

        track.status = TrackJobStatus.DOWNLOADING;
        this.activeDownloads++;
        this.emit(job, track);

        try {
          await processor(track);
          track.status = TrackJobStatus.COMPLETED;
          job.completedTracks++;
        } catch (err: any) {
          track.status = TrackJobStatus.FAILED;
          track.error = err?.message || 'Unknown error';
          track.retryCount = (track.retryCount || 0) + 1;
          job.failedTracks++;
        } finally {
          this.activeDownloads--;
          this.emit(job, track);
        }
      }

      if (this.cancelled) {
        // Mark remaining queued tracks as cancelled
        for (const t of this.queue) {
          t.status = TrackJobStatus.CANCELLED;
        }
        job.cancelledTracks = this.queue.length;
        this.queue = [];
      }
      job.status =
        job.failedTracks > 0 && job.completedTracks > 0
          ? TrackJobStatus.COMPLETED
          : job.completedTracks > 0
          ? TrackJobStatus.COMPLETED
          : TrackJobStatus.FAILED;
    };

    await run();
    return job;
  }

  cancel(): void {
    this.cancelled = true;
  }
}
