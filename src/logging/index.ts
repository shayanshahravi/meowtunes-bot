export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const level = (process.env.LOG_LEVEL as keyof typeof LogLevel) || 'INFO';

function format(message: string, meta?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] ${message}${metaStr}`;
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => {
    if (LogLevel[level] <= LogLevel.DEBUG) console.log(format(`[DEBUG] ${msg}`, meta));
  },
  info: (msg: string, meta?: Record<string, unknown>) => {
    if (LogLevel[level] <= LogLevel.INFO) console.log(format(`[INFO] ${msg}`, meta));
  },
  warn: (msg: string, meta?: Record<string, unknown>) => {
    if (LogLevel[level] <= LogLevel.WARN) console.warn(format(`[WARN] ${msg}`, meta));
  },
  error: (msg: string, meta?: Record<string, unknown>) => {
    if (LogLevel[level] <= LogLevel.ERROR) console.error(format(`[ERROR] ${msg}`, meta));
  },
};