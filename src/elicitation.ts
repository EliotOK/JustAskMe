/**
 * Thin, defensive wrapper around the MCP SDK's form-elicitation primitive.
 *
 * Verified against `@modelcontextprotocol/sdk@1.30.0`
 * (`dist/esm/server/index.d.ts:158`, `dist/esm/server/index.js:340`):
 *
 *   elicitInput(params: ElicitRequestFormParams | ElicitRequestURLParams,
 *               options?: RequestOptions): Promise<ElicitResult>
 *
 * Two behaviours in that implementation drive the whole design here:
 *
 *   1. If the client did not declare an `elicitation` capability at all, the SDK
 *      **throws** `Error('Client does not support elicitation (required for
 *      elicitation/create)')` before sending anything. We pre-check the
 *      capability anyway, and additionally classify that exact throw, so a
 *      stale/skewed SDK cannot turn into an unhandled crash. Note the SDK's own
 *      gate is a *truthy* `elicitation` object — not `elicitation.form` — and
 *      its capability parser normalizes a legacy bare `elicitation: {}` into
 *      `{ form: {} }` during initialize, so we mirror the SDK's gate here
 *      instead of requiring `.form` ourselves.
 *   2. `RequestOptions.timeout` defaults to `DEFAULT_REQUEST_TIMEOUT_MSEC`
 *      (60_000). A human reading a question can easily take longer, so we
 *      always pass an explicit timeout.
 *
 * The SDK also validates accepted `content` against `requestedSchema` and
 * raises `McpError(InvalidParams)` on mismatch — including the "client approved
 * but submitted empty content" case. We surface that as `invalid_response`
 * rather than letting it escape as a tool-call failure.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { FormRequest } from './forms.js';
import { log } from './logger.js';
import type { ElicitationFailure, ElicitationOutcome } from './outcome.js';

/** True when the connected client declared an MCP elicitation capability. */
export function clientSupportsFormElicitation(server: McpServer): boolean {
  try {
    const capabilities = server.server.getClientCapabilities();
    // Same gate as the SDK's assertCapabilityForMethod: any truthy elicitation
    // object. Requiring `.form` would diverge from the SDK and could route
    // clients with exotic/legacy capability shapes to the fallback even though
    // `elicitInput` would serve them.
    return Boolean(capabilities?.elicitation);
  } catch (error) {
    log.debug('capability probe failed:', error);
    return false;
  }
}

export interface ElicitOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export function classifyElicitationError(
  error: unknown,
  ownSignal: AbortSignal | undefined
): { reason: ElicitationFailure; detail: string } {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  // Cancellation must be checked before any error-code mapping: the SDK turns
  // an aborted `options.signal` into `McpError(RequestTimeout, reason)`, which
  // is otherwise indistinguishable from a genuine timeout.
  if (ownSignal?.aborted) {
    return { reason: 'aborted', detail };
  }
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) return { reason: 'timeout', detail };
    if (error.code === ErrorCode.InvalidParams) return { reason: 'invalid_response', detail };
  }
  if (/does not support elicitation/i.test(detail)) return { reason: 'no_capability', detail };
  if (error instanceof Error && error.name === 'AbortError') return { reason: 'aborted', detail };
  return { reason: 'transport_error', detail };
}

/**
 * Runs one `elicitation/create` (mode `form`) round-trip.
 *
 * Never throws: every failure is folded into {@link ElicitationOutcome} so the
 * caller can apply its fallback policy.
 */
export async function requestFormInput(
  server: McpServer,
  request: FormRequest,
  options: ElicitOptions
): Promise<ElicitationOutcome> {
  if (!clientSupportsFormElicitation(server)) {
    return {
      ok: false,
      reason: 'no_capability',
      detail: 'client did not declare an elicitation capability'
    };
  }

  const started = Date.now();
  try {
    const result: ElicitResult = await server.server.elicitInput(
      {
        mode: 'form',
        message: request.message,
        requestedSchema: request.requestedSchema
      },
      {
        timeout: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {})
      }
    );

    log.debug(`elicitation/create resolved in ${Date.now() - started}ms:`, result.action);

    if (result.action === 'accept') {
      if (!result.content || Object.keys(result.content).length === 0) {
        return {
          ok: false,
          reason: 'invalid_response',
          detail: 'client returned action=accept with empty content'
        };
      }
      return { ok: true, action: 'accept', content: result.content };
    }

    return { ok: true, action: result.action };
  } catch (error) {
    const classified = classifyElicitationError(error, options.signal);
    log.debug(`elicitation/create failed (${classified.reason}): ${classified.detail}`);
    return { ok: false, reason: classified.reason, detail: classified.detail };
  }
}
