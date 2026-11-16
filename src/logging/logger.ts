export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const LEVELS: Record<string, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const activeLevel = LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] ?? LEVELS.INFO;

function redact(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]')
    .replace(/("?(?:token|authorization|password|Qi)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[REDACTED]');
}

function emit(level: keyof typeof LEVELS, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < activeLevel) return;
  const ts = new Date().toISOString();
  const safeMsg = redact(msg) as string;
  const safeMeta = meta
    ? JSON.parse(JSON.stringify(meta, (k, v) =>
        k.toLowerCase().includes('token') || k.toLowerCase().includes('authorization')
          ? '[REDACTED]'
          : redact(v)
      ))
    : undefined;
  const line = safeMeta
    ? `${ts} [${level}] ${safeMsg} ${JSON.stringify(safeMeta)}`
    : `${ts} [${level}] ${safeMsg}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

export const logger: Logger = {
  debug: (m, meta) => emit('DEBUG', m, meta),
  info: (m, meta) => emit('INFO', m, meta),
  warn: (m, meta) => emit('WARN', m, meta),
  error: (m, meta) => emit('ERROR', m, meta),
};
