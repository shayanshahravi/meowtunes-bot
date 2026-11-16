import { TelegramService } from './TelegramService';
import { TrackJob, TrackJobStatus, TrackJobForPlaylist } from '../queue/jobs';
import { QueueManager } from '../queue/QueueManager';
import { formatBytes, formatDuration, progressBar } from '../utils/helpers';
import { MeowTunesError } from '../utils/errors';
import { Logger, logger } from '../logging/logger';

export class TelegramProgress {
  constructor(
    private readonly telegram: TelegramService,
    private readonly chatId: number,
    private readonly log: Logger = logger
  ) {}

  private lastMessageId: number | null = null;
  private currentText = '';

  update(job: TrackJob, current: TrackJobForPlaylist | null): string {
    const pct = job.totalTracks > 0 ? Math.round((job.completedTracks / job.totalTracks) * 100) : 0;
    const bar = progressBar(job.completedTracks, job.totalTracks);
    const currentLine = current ? `<b>${current.title}</b>` : 'Waiting...';
    const status =
      job.status === TrackJobStatus.CANCELLED
        ? '🚫 Cancelled'
        : job.status === TrackJobStatus.FAILED && job.completedTracks === 0
        ? '❌ Failed'
        : '⏳ Downloading';

    const text = `<b>📂 ${job.playlistTitle}</b>
${status}

Downloaded: ${job.completedTracks} / ${job.totalTracks}
Failed: ${job.failedTracks}

${bar} ${pct}%

Current: ${currentLine}`;

    this.currentText = text;
    return text;
  }

  async push(job: TrackJob, current: TrackJobForPlaylist | null): Promise<void> {
    const text = this.update(job, current);
    try {
      if (!this.lastMessageId) {
        const result = await this.telegram.sendMessage(this.chatId, text);
        this.lastMessageId = result.messageId;
      } else {
        await this.telegram.editMessage(this.chatId, this.lastMessageId, text);
      }
    } catch (err: any) {
      this.log.warn('progress update failed', { error: err.message });
    }
  }

  reset(): void {
    this.lastMessageId = null;
    this.currentText = '';
  }
}
