/**
 * stderr-only logging.
 *
 * MCP stdio transport owns stdout: every byte written there must be a JSON-RPC
 * frame. A stray `console.log` corrupts the stream and the client drops the
 * connection ("failed to parse message"). So:
 *
 *   1. every log line in this project goes to `process.stderr`;
 *   2. `redirectConsoleToStderr()` is installed at startup as a seatbelt, in
 *      case a dependency (or a future edit) calls `console.log` by accident.
 */
import { format } from 'node:util';

export const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;

export type LogLevel = keyof typeof LOG_LEVELS;

const DEFAULT_LEVEL: LogLevel = 'info';

let threshold: number = LOG_LEVELS[DEFAULT_LEVEL];

/** Sets the global log threshold; unknown values fall back to `info`. */
export function setLogLevel(level: string | undefined): LogLevel {
  const key = (level ?? '').trim().toLowerCase();
  const resolved = (key in LOG_LEVELS ? key : DEFAULT_LEVEL) as LogLevel;
  threshold = LOG_LEVELS[resolved];
  return resolved;
}

function write(level: Exclude<LogLevel, 'silent'>, args: unknown[]): void {
  if (LOG_LEVELS[level] > threshold) return;
  try {
    process.stderr.write(`[codex-human-input-mcp] ${level}: ${format(...args)}\n`);
  } catch {
    // Logging must never take the server down.
  }
}

export const log = {
  error: (...args: unknown[]): void => write('error', args),
  warn: (...args: unknown[]): void => write('warn', args),
  info: (...args: unknown[]): void => write('info', args),
  debug: (...args: unknown[]): void => write('debug', args)
};

/**
 * Point `console.log`/`info`/`debug`/`warn` at stderr so nothing can ever leak
 * into the JSON-RPC channel. `console.error` already targets stderr.
 */
export function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    try {
      process.stderr.write(`${format(...args)}\n`);
    } catch {
      /* ignore */
    }
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
}
