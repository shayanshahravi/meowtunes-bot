/**
 * Worker environment bindings + safe logger.
 * No Node.js APIs here — pure Web runtime only.
 * Secret VALUES are never logged; keys containing token/secret/authorization
 * are redacted along with any `Bearer ...` material.
 */

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OWNER_TELEGRAM_USER_ID: string;
  MEEWTUNES_BEARER_TOKEN: string;
  MEOWTUNES_BASE_URL?: string;
  MAX_TRACKS_PER_PLAYLIST?: string;
  MAX_FILE_SIZE_MB?: string;
  MAX_RETRIES?: string;
  REQUEST_TIMEOUT_MS?: string;
  LOG_LEVEL?: string;
}

export interface WorkerConfig {
  botToken: string;
  webhookSecret: string;
  ownerUserId: number;
  meowtunesToken: string;
  baseUrl: string;
  maxTracksPerPlaylist: number;
  maxFileSizeBytes: number;
  maxRetries: number;
  requestTimeoutMs: number;
}

function num(v: string | undefined, dflt: number): number {
  const n = v === undefined || v === '' ? NaN : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function loadConfig(env: Env): WorkerConfig {
  const missing: string[] = [];
  if (!env.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!env.TELEGRAM_WEBHOOK_SECRET) missing.push('TELEGRAM_WEBHOOK_SECRET');
  if (!env.OWNER_TELEGRAM_USER_ID) missing.push('OWNER_TELEGRAM_USER_ID');
  if (!env.MEEWTUNES_BEARER_TOKEN) missing.push('MEEWTUNES_BEARER_TOKEN');
  if (missing.length > 0) throw new Error(`Missing Worker secrets: ${missing.join(', ')}`);
  const ownerUserId = parseInt(env.OWNER_TELEGRAM_USER_ID, 10);
  if (!Number.isFinite(ownerUserId)) throw new Error('OWNER_TELEGRAM_USER_ID must be numeric');
  // Prod base per verified contract: https://api2.vasl.social/api
  return {
    botToken: env.TELEGRAM_BOT_TOKEN,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    ownerUserId,
    meowtunesToken: env.MEEWTUNES_BEARER_TOKEN,
    baseUrl: (env.MEOWTUNES_BASE_URL || 'https://api2.vasl.social/api').replace(/\/+$/, ''),
    maxTracksPerPlaylist: num(env.MAX_TRACKS_PER_PLAYLIST, 50),
    maxFileSizeBytes: num(env.MAX_FILE_SIZE_MB, 50) * 1024 * 1024,
    maxRetries: num(env.MAX_RETRIES, 3),
    requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, 30000),
  };
}

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
const ORDER: Record<Level, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function redactValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  return v
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/("?(?:token|authorization|password|secret)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[REDACTED]');
}

export function createLogger(levelRaw?: string) {
  const active = ORDER[(levelRaw || 'INFO').toUpperCase() as Level] ?? ORDER.INFO;
  const emit = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    if (ORDER[level] < active) return;
    const safe = meta
      ? JSON.parse(
          JSON.stringify(meta, (k, v) =>
            /token|authorization|secret/i.test(k) ? '[REDACTED]' : redactValue(v),
          ),
        )
      : undefined;
    const line =
      `${new Date().toISOString()} [${level}] ${redactValue(msg) as string}` +
      (safe ? ` ${JSON.stringify(safe)}` : '');
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m: string, meta?: Record<string, unknown>) => emit('DEBUG', m, meta),
    info: (m: string, meta?: Record<string, unknown>) => emit('INFO', m, meta),
    warn: (m: string, meta?: Record<string, unknown>) => emit('WARN', m, meta),
    error: (m: string, meta?: Record<string, unknown>) => emit('ERROR', m, meta),
  };
}

export type WorkerLogger = ReturnType<typeof createLogger>;

/** Minimal subset of the Workers runtime context we use (waitUntil). */
export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}
