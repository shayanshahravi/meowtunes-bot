import crypto from 'crypto';

export function sanitizeFilename(name: string, maxLen = 200): string {
  return name
    .replace(/[<>:"\/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function generateJobId(): string {
  return `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function progressBar(current: number, total: number, width = 20): string {
  if (total <= 0) return '░'.repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((current / total) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}