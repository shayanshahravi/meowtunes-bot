export enum TrackJobStatus {
  QUEUED = 'QUEUED',
  RESOLVING = 'RESOLVING',
  DOWNLOADING = 'DOWNLOADING',
  VALIDATING = 'VALIDATING',
  UPLOADING = 'UPLOADING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export interface TrackJob {
  jobId: string;
  telegramUserId: number;
  playlistId: string;
  playlistTitle: string;
  totalTracks: number;
  completedTracks: number;
  failedTracks: number;
  cancelledTracks: number;
  status: TrackJobStatus;
  tracks: TrackJobForPlaylist[];
}

export interface TrackJobForPlaylist {
  trackId: string;
  songId: string;
  fileId: string;
  title: string;
  artist?: string;
  album?: string;
  status: TrackJobStatus;
  retryCount: number;
  error?: string;
}

export interface CreateJobParams {
  telegramUserId: number;
  playlistId: string;
  playlistTitle: string;
  totalTracks: number;
  tracks: Array<{
    trackId: string;
    songId: string;
    fileId: string;
    title: string;
    artist?: string;
    album?: string;
  }>;
}