#!/usr/bin/env node
/**
 * End-to-end smoke test over a real stdio MCP connection.
 *
 * This is the closest thing to "does Codex see this server" that can be run
 * without Codex: it spawns the built entry point as a child process, performs
 * the MCP handshake exactly as a client would, and scripts a human answering.
 *
 *   npm run build
 *   node scripts/smoke-stdio.mjs            # scripted answers
 *   node scripts/smoke-stdio.mjs --manual   # prints the real question, waits for you
 *
 * Exit code 0 means every check passed.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const manual = process.argv.includes('--manual');
// Optional positional argument: the server entry to smoke-test. Defaults to the
// local tsc build; pass a path to test a shipped artifact (for example the
// bundled `plugins/<name>/server/index.mjs`) instead.
const entryArg = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const entry = entryArg ? path.resolve(entryArg) : path.join(here, '..', 'dist', 'index.js');

if (!existsSync(entry)) {
  console.error(`build output not found at ${entry}\nRun: npm run build`);
  process.exit(2);
}

let failures = 0;
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/** Presents the real elicitation request on the terminal and reads a reply. */
async function askOnTerminal(request) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.log('\n--- elicitation/create received from the server ---');
    console.log(request.params.message);
    const schema = request.params.requestedSchema;
    const answer = await rl.question('\nType the value for the required field (or "cancel"): ');
    if (answer.trim().toLowerCase() === 'cancel') return { action: 'cancel' };
    const field = schema.required?.[0] ?? Object.keys(schema.properties)[0];
    let value = answer;
    if (schema.properties[field]?.type === 'boolean') value = answer.trim().toLowerCase().startsWith('y');
    if (schema.properties[field]?.type === 'array') value = answer.split(',').map(part => part.trim());
    return { action: 'accept', content: { [field]: value } };
  } finally {
    rl.close();
  }
}

function scriptedResponder(request) {
  const schema = request.params.requestedSchema;
  const field = schema.required?.[0] ?? Object.keys(schema.properties)[0];
  const property = schema.properties[field];
  let value;
  if (property.type === 'boolean') value = true;
  else if (property.type === 'array') value = property.items.enum.slice(0, 1);
  else value = property.enum?.[1] ?? 'smoke-test answer';
  console.log(`     (scripted human answers ${field}=${JSON.stringify(value)})`);
  return { action: 'accept', content: { [field]: value } };
}

async function connect({ capabilities, onElicit }) {
  const client = new Client({ name: 'smoke-client', version: '0.0.0' }, { capabilities });
  // The SDK's Client refuses to register a handler for a capability it did not
  // declare, so a deliberately incapable client simply has no handler.
  if (capabilities.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async request => onElicit(request));
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, HIM_LOG: 'debug' },
    stderr: 'inherit'
  });
  await client.connect(transport);
  return client;
}

async function main() {
  console.log(`spawning: ${process.execPath} ${entry}\n`);

  // --- 1. A client that supports form elicitation --------------------------
  const capable = await connect({
    capabilities: { elicitation: { form: {} } },
    onElicit: manual ? askOnTerminal : scriptedResponder
  });
  try {
    const { tools } = await capable.listTools();
    check(
      'server advertises the five tools',
      tools.length === 5,
      tools.map(tool => tool.name).join(', ')
    );

    const answered = await capable.callTool({
      name: 'ask_choice',
      arguments: {
        question: 'Smoke test: which transport should the fixture use?',
        options: [
          { label: 'stdio', description: 'Standard input/output.' },
          { label: 'http', description: 'Streamable HTTP.' }
        ],
        allow_free_text: true,
        timeout_ms: 120_000
      }
    });
    const result = answered.structuredContent;
    check('ask_choice returned status=answered', result?.status === 'answered', String(result?.status));
    check('ask_choice came back via elicitation', result?.via === 'elicitation', String(result?.via));
    check('ask_choice returned a non-empty answer', Boolean(result?.answer), JSON.stringify(result?.answer));

    const confirm = await capable.callTool({
      name: 'ask_confirm',
      arguments: { question: 'Smoke test: does the confirm path work?', timeout_ms: 120_000 }
    });
    check(
      'ask_confirm returned a boolean',
      confirm.structuredContent?.confirmed === true,
      JSON.stringify(confirm.structuredContent?.confirmed)
    );

    const status = await capable.callTool({ name: 'human_input_status', arguments: { verbose: true } });
    const report = JSON.parse(status.content.find(block => block.type === 'text').text);
    check('server reports client elicitation support', report.client_supports_form_elicitation === true);
  } finally {
    await capable.close();
  }

  // --- 2. A client with no elicitation support -----------------------------
  const plain = await connect({ capabilities: {}, onElicit: () => ({ action: 'cancel' }) });
  try {
    const degraded = await plain.callTool({
      name: 'ask_choice',
      arguments: {
        question: 'Smoke test: this client cannot render forms.',
        options: [{ label: 'a' }, { label: 'b' }],
        timeout_ms: 5_000
      }
    });
    const result = degraded.structuredContent;
    check(
      'a non-elicitation client gets needs_user_input instead of a hang',
      result?.status === 'needs_user_input',
      String(result?.status)
    );
    check('the fallback payload carries the options', /1\. a/.test(result?.message ?? ''));
    check('the fallback is not flagged as an error', degraded.isError !== true);
  } finally {
    await plain.close();
  }

  console.log(`\n${failures === 0 ? 'smoke test OK' : `smoke test FAILED (${failures} check(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error('\nsmoke test crashed:', error);
  process.exit(1);
});
