/**
 * Timeout handling.
 *
 * The MCP SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC` is 60_000, so a naive
 * implementation would silently cap every question at one minute regardless of
 * configuration. These tests pin our explicit timeout to a few hundred
 * milliseconds and assert the whole call settles in that window — which can
 * only pass if `RequestOptions.timeout` is actually being passed through.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { askResultSchema } from '../src/schemas.js';
import { callTool, startHarness } from './helpers.js';

const ARGS = {
  name: 'ask_choice',
  arguments: {
    question: 'Which license should this repository use?',
    options: [{ label: 'MIT' }, { label: 'Apache-2.0' }]
  }
};

describe('question timeout', () => {
  it('gives up after the configured timeout and reports status=timeout', async () => {
    const harness = await startHarness({
      config: { timeoutMs: 300, fallback: 'return' },
      onElicit: () => new Promise(() => undefined) // nobody ever answers
    });
    try {
      const started = Date.now();
      const call = await callTool(harness.client, ARGS);
      const elapsed = Date.now() - started;

      assert.equal(call.ask.status, 'timeout');
      assert.equal(call.ask.via, 'elicitation');
      assert.equal(call.ask.answer, null);
      assert.ok(elapsed >= 280, `settled too early (${elapsed}ms)`);
      assert.ok(elapsed < 5_000, `did not honour the configured timeout (${elapsed}ms)`);
      assert.ok(call.ask.elapsed_ms >= 280 && call.ask.elapsed_ms < 5_000, `elapsed_ms=${call.ask.elapsed_ms}`);
      assert.match(call.ask.message, /timed out/);
      assert.ok(askResultSchema.safeParse(call.ask).success);
      assert.match(call.text, /next_step:/);
    } finally {
      await harness.close();
    }
  });

  it('honours a per-call timeout_ms override', async () => {
    const harness = await startHarness({
      config: { timeoutMs: 60_000, fallback: 'return' },
      onElicit: () => new Promise(() => undefined)
    });
    try {
      const started = Date.now();
      const call = await callTool(harness.client, {
        name: 'ask_confirm',
        arguments: { question: 'Proceed?', timeout_ms: 1_000 }
      });
      const elapsed = Date.now() - started;
      assert.equal(call.ask.status, 'timeout');
      assert.ok(elapsed < 10_000, `per-call timeout_ms was ignored (${elapsed}ms)`);
    } finally {
      await harness.close();
    }
  });

  it('never blocks forever once the caller walks away', async () => {
    const harness = await startHarness({
      config: { timeoutMs: 200, fallback: 'off' },
      onElicit: () => new Promise(() => undefined)
    });
    try {
      const call = await callTool(harness.client, ARGS);
      assert.equal(call.ask.status, 'timeout');
      assert.equal(call.ask.fallback, 'off');
      assert.equal(call.ask.client_elicitation, true);
    } finally {
      await harness.close();
    }
  });
});
