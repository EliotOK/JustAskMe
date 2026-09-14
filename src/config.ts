/** Build-time identity of this MCP server. */
export const SERVER_NAME = 'codex-human-input-mcp';
export const SERVER_VERSION = '0.1.1';

/**
 * What to do when native MCP form elicitation is unavailable, fails, or is
 * declined by the client.
 *
 * - `return` (default) — never block. Hand the agent a structured "please ask
 *   the human" payload so it can ask in chat and move on.
 * - `http` — start a one-shot loopback form page, print the URL to stderr, and
 *   block until it is answered or the timeout fires. Opt-in, because it needs
 *   a browser.
 * - `off` — surface a hard `isError` tool result.
 */
export type FallbackMode = 'return' | 'http' | 'off';

/**
 * How `ask_multi_select` is expressed to the client.
 *
 * - `array` (default) — a real JSON-Schema array of enums, which MCP form
 *   elicitation renders as a multi-select control.
 * - `text` — a single string field parsed into labels. Escape hatch for
 *   clients that render arrays poorly.
 */
export type MultiSelectMode = 'array' | 'text';

export interface ServerConfig {
  /** How long a single question may stay unanswered before it times out. */
  timeoutMs: number;
  fallback: FallbackMode;
  /** Open the OS default browser for the `http` fallback. */
  httpOpenBrowser: boolean;
  httpHost: string;
  /** 0 = pick a free ephemeral port. */
  httpPort: number;
  multiSelectMode: MultiSelectMode;
  /**
   * A `decline` that arrives faster than this is probably a client-side
   * auto-reject (e.g. Codex with `approval_policy.granular.mcp_elicitations =
   * false`), not a human clicking "no".
   */
  autoRejectThresholdMs: number;
  logLevel: string;
}

export const DEFAULT_CONFIG: ServerConfig = {
  timeoutMs: 300_000,
  fallback: 'return',
  httpOpenBrowser: true,
  httpHost: '127.0.0.1',
  httpPort: 0,
  multiSelectMode: 'array',
  autoRejectThresholdMs: 400,
  logLevel: 'info'
};

function readNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const int = Math.trunc(value);
  if (int < min) return min;
  if (int > max) return max;
  return int;
}

function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function readEnum<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T {
  const value = (raw ?? '').trim().toLowerCase();
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

const FALLBACK_MODES = ['return', 'http', 'off'] as const;
const MULTI_SELECT_MODES = ['array', 'text'] as const;

/** Reads configuration from `HIM_*` environment variables. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    timeoutMs: readNumber(env['HIM_TIMEOUT_MS'], DEFAULT_CONFIG.timeoutMs, 1_000, 3_600_000),
    fallback: readEnum(env['HIM_FALLBACK'], FALLBACK_MODES, DEFAULT_CONFIG.fallback),
    httpOpenBrowser: readBoolean(env['HIM_HTTP_OPEN'], DEFAULT_CONFIG.httpOpenBrowser),
    httpHost: env['HIM_HTTP_HOST']?.trim() || DEFAULT_CONFIG.httpHost,
    httpPort: readNumber(env['HIM_HTTP_PORT'], DEFAULT_CONFIG.httpPort, 0, 65_535),
    multiSelectMode: readEnum(env['HIM_MULTISELECT_MODE'], MULTI_SELECT_MODES, DEFAULT_CONFIG.multiSelectMode),
    autoRejectThresholdMs: readNumber(
      env['HIM_AUTO_REJECT_MS'],
      DEFAULT_CONFIG.autoRejectThresholdMs,
      0,
      60_000
    ),
    logLevel: env['HIM_LOG']?.trim() || DEFAULT_CONFIG.logLevel
  };
}

/** Env-derived config with explicit overrides on top (used heavily by tests). */
export function resolveConfig(
  overrides: Partial<ServerConfig> = {},
  env: NodeJS.ProcessEnv = process.env
): ServerConfig {
  const base = configFromEnv(env);
  const merged: ServerConfig = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}
