/**
 * Test harness: a real MCP `Client` and a real MCP server wired together over
 * `InMemoryTransport`.
 *
 * Deliberately not a stub of our own code — the point is to exercise the real
 * SDK handshake, the real capability negotiation, the real
 * `elicitation/create` round-trip, and the real response validation. Only the
 * human is simulated.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { CallToolResultSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
  CallToolRequest,
  CallToolResult,
  ClientCapabilities,
  ElicitRequest,
  ElicitRequestFormParams,
  ElicitResult
} from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig } from '../src/config.js';
import type { AskResult } from '../src/outcome.js';
import { createServer } from '../src/server.js';

export const ELICITATION_CAPABLE: ClientCapabilities = { elicitation: { form: {} } };

export interface HarnessOptions {
  /** Config overrides; `fallback: 'off'` and a short timeout by default. */
  config?: Partial<ServerConfig>;
  /** Capabilities the fake client advertises. Defaults to full form elicitation. */
  capabilities?: ClientCapabilities;
  /** How the fake human responds. Defaults to `cancel`. */
  onElicit?: (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>;
}

export interface Harness {
  client: Client;
  /** The server under test, for white-box assertions on the pipeline. */
  server: McpServer;
  config: ServerConfig;
  /** Every `elicitation/create` the server sent, in order. */
  seen: ElicitRequestFormParams[];
  close: () => Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { server, config } = createServer({ fallback: 'off', timeoutMs: 2_000, ...options.config });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const capabilities = options.capabilities ?? ELICITATION_CAPABLE;
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities });

  const seen: ElicitRequestFormParams[] = [];
  const responder = options.onElicit;
  // The SDK's Client refuses to register a request handler for a capability it
  // did not declare ("Client does not support elicitation capability"), so only
  // install the fake human when the fake client actually claims support.
  if (capabilities.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request: ElicitRequest): Promise<ElicitResult> => {
      seen.push(request.params as ElicitRequestFormParams);
      if (!responder) return { action: 'cancel' };
      return await responder(request);
    });
  }

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    server,
    config,
    seen,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
}

/** A tool call, normalized: the SDK returns a union type for `callTool`. */
export interface ToolCall {
  raw: CallToolResult;
  ask: AskResult;
  text: string;
  isError: boolean;
}

/** Calls a tool and normalizes the SDK's union return type into something readable. */
export async function callTool(
  client: Client,
  params: CallToolRequest['params'],
  options?: RequestOptions
): Promise<ToolCall> {
  const raw = (await client.callTool(params, CallToolResultSchema, options)) as unknown as CallToolResult;
  return { raw, ask: asAskResult(raw), text: textOf(raw), isError: raw.isError === true };
}

/** Narrows a tool result's structured content to our uniform result type. */
export function asAskResult(result: unknown): AskResult {
  const structured = (result as CallToolResult | undefined)?.structuredContent;
  if (!structured) {
    throw new Error(`tool result had no structuredContent: ${JSON.stringify(result)}`);
  }
  return structured as unknown as AskResult;
}

/** The concatenated text blocks a tool returned, for asserting on the prose. */
export function textOf(result: unknown): string {
  const blocks = ((result as CallToolResult | undefined)?.content ?? []) as { type: string; text?: string }[];
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n');
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
