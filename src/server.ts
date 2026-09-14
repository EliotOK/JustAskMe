import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION, resolveConfig } from './config.js';
import type { ServerConfig } from './config.js';
import { registerTools } from './tools.js';

/**
 * Sent to the client during initialize. MCP clients that surface server
 * instructions (and models that read them) get the "when to ask" discipline for
 * free, without depending on AGENTS.md being present in the repo.
 */
export const SERVER_INSTRUCTIONS = [
  'This server lets you ask the human a structured question and wait for the answer, similar to Claude Code\'s AskUserQuestion.',
  '',
  'Ask only when the decision outranks the interruption:',
  '- the request is genuinely ambiguous and a wrong guess means redoing work;',
  '- the choice of architecture or approach materially changes the implementation;',
  '- several options are defensible and user preference decides;',
  '- the action deletes, overwrites, migrates, or is otherwise destructive;',
  '- the user-visible behaviour has a real trade-off.',
  '',
  'Do not ask about details you can safely infer, read from the repo, or fix later. If the answer would not change what you do next, do not ask.',
  '',
  'Tool choice: ask_choice for 2-5 viable candidates, ask_confirm for a yes/no gate, ask_text for genuinely open input, ask_multi_select for choosing a subset.',
  '',
  'Always honour the returned `status`. Only `answered` carries a usable answer. On `needs_user_input`, present the question and options to the user in chat and continue with their reply. On `declined`, `cancelled`, or `timeout`, do not guess on anything destructive — pick the conservative option, state the assumption, or report the blocker.'
].join('\n');

export interface CreatedServer {
  server: McpServer;
  config: ServerConfig;
}

/** Builds a fully wired MCP server. Overrides win over `HIM_*` env vars. */
export function createServer(overrides: Partial<ServerConfig> = {}): CreatedServer {
  const config = resolveConfig(overrides);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );
  registerTools(server, config);
  return { server, config };
}
