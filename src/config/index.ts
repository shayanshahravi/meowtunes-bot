import dotenv from 'dotenv';
dotenv.config();

export const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
    ownerUserId: parseInt(process.env.OWNER_TELEGRAM_USER_ID || '0', 10),
  },
  meowtunes: {
    baseUrl: process.env.MEOWTUNES_BASE_URL || 'https://vasl.social/api',
    token: process.env.MEEWTUNES_BEARER_TOKEN || '',
  },
  download: {
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '2', 10),
    maxTracksPerPlaylist: parseInt(process.env.MAX_TRACKS_PER_PLAYLIST || '50', 10),
    maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10) * 1024 * 1024,
    maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10),
  },
  networkMode: (process.env.NETWORK_MODE || 'direct') as 'direct' | 'worker',
};

export function validateConfig(): string[] {
  const errors: string[] = [];
  if (!config.telegram.botToken) errors.push('TELEGRAM_BOT_TOKEN is required');
  if (!config.telegram.ownerUserId) errors.push('OWNER_TELEGRAM_USER_ID is required');
  if (!config.meowtunes.token) errors.push('MEEWTUNES_BEARER_TOKEN is required');
  if (!config.meowtunes.baseUrl) errors.push('MEOWTUNES_BASE_URL is required');
  return errors;
}