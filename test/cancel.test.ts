/**
 * Cancellation paths, and the capability fallback that fires when a client
 * cannot do form elicitation at all.
 *
 * The abort case is the subtle one: the MCP SDK converts an aborted request
 * into `McpError(ErrorCode.RequestTimeout, ...)`, which is indistinguishable
 * from a genuine timeout unless you check the signal first. If that ordering
 * ever regresses, a user pressing Ctrl-C mid-question would be reported to the
 * agent as a timeout — and the agent would then feel free to "proceed with an
 * assumption" after a cancellation. So it is asserted explicitly.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { FormQuestion } from '../src/outcome.js';
import { runQuestion } from '../src/tools.js';
import { callTool, startHarness } from './helpers.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const QUESTION: FormQuestion = {
  kind: 'choice',
  question: 'Which target environment?',
  options: [
    { label: 'staging', description: 'Safe.' },
    { label: 'production', description: 'Live traffic.' }
  ],
  allowFreeText: false
};

const ARGS = {
  name: 'ask_choice',
  arguments: {
    question: 'Which target environment?',
    options: [
      { label: 'staging', description: 'Safe.' },
      { label: 'production', description: 'Live traffic.' }
    ],
    timeout_ms: 5_000
  }
};

describe('decline and cancel', () => {
  it('reports a genuine decline as declined and tells the agent not to re-ask', async () => {
    const harness = await startHarness({
      // 0 disables the auto-reject heuristic, so this decline is treated as a human decision.
      config: { autoRejectThresholdMs: 0 },
      onElicit: () => ({ action: 'decline' })
    });
    try {
      const call = await callTool(harness.client, ARGS);
      assert.equal(call.ask.status, 'declined');
      assert.equal(call.ask.via, 'elicitation');
      assert.equal(call.ask.answer, null);
      assert.equal(call.ask.auto_reject_suspected, false);
      assert.match(call.ask.next_step, /Do not ask again/);
      assert.equal(call.isError, false);
    } finally {
      await harness.close();
    }
  });

  it('reports a dismissal as cancelled rather than as an answer or a timeout', async () => {
    const harness = await startHarness({ onElicit: () => ({ action: 'cancel' }) });
    try {
      const call = await callTool(harness.client, ARGS);
      assert.equal(call.ask.status, 'cancelled');
      assert.equal(call.ask.via, 'elicitation');
      assert.match(call.ask.next_step, /never permission to guess/);
    } finally {
      await harness.close();
    }
  });

  it('suspects a client-side auto-reject when decline returns instantly', async () => {
    const harness = await startHarness({
      config: { autoRejectThresholdMs: 5_000, fallback: 'return' },
      onElicit: () => ({ action: 'decline' })
    });
    try {
      const call = await callTool(harness.client, ARGS);
      assert.equal(call.ask.auto_reject_suspected, true);
      // Crucially it is NOT reported as a human "no".
      assert.equal(call.ask.status, 'needs_user_input');
      assert.match(call.ask.message, /auto-rejecting elicitation/);
      assert.match(call.ask.message, /1\. staging — Safe\./);
    } finally {
      await harness.close();
    }
  });

  it('treats an aborted tool call as cancelled, never as a timeout', async () => {
    const harness = await startHarness({
      config: { timeoutMs: 10_000, autoRejectThresholdMs: 0 },
      onElicit: () => new Promise(() => undefined) // the human never answers
    });
    try {
      const controller = new AbortController();
      const extra = { signal: controller.signal } as unknown as Extra;
      const pending = runQuestion('ask_choice', QUESTION, 10_000, {
        server: harness.server,
        config: harness.config,
        extra
      });
      setTimeout(() => controller.abort(), 60);

      const outcome = await pending;
      assert.equal(outcome.result.status, 'cancelled');
      assert.notEqual(outcome.result.status, 'timeout');
      assert.equal(outcome.isError, false);
      assert.ok(outcome.result.elapsed_ms < 5_000, 'abort must short-circuit the wait');
    } finally {
      await harness.close();
    }
  });
});

describe('clients without form elicitation', () => {
  it('falls back to a structured hand-off when HIM_FALLBACK=return', async () => {
    const harness = await startHarness({ capabilities: {}, config: { fallback: 'return' } });
    try {
      const call = await callTool(harness.client, ARGS);
      assert.equal(call.ask.status, 'needs_user_input');
      assert.equal(call.ask.via, 'none');
      assert.equal(call.ask.client_elicitation, false);
      assert.equal(call.isError, false, 'the model can still act on this result');

      assert.match(call.text, /Which target environment\?/);
      assert.match(call.text, /1\. staging — Safe\./);
      assert.match(call.text, /2\. production — Live traffic\./);
      assert.match(call.ask.next_step, /Reproduce this question/);

      // Nothing was sent to the client; the server never even tried.
      assert.equal(harness.seen.length, 0);
    } finally {
      await harness.close();
    }
  });

  it('returns a hard unsupported error when HIM_FALLBACK=off', async () => {
    const harness = await startHarness({ capabilities: {}, config: { fallback: 'off' } });
    try {
      const call = await callTool(harness.client, ARGS);
      assert.equal(call.ask.status, 'unsupported');
      assert.equal(call.isError, true);
      assert.match(call.ask.message, /does not support MCP form elicitation/);
    } finally {
      await harness.close();
    }
  });

  it('still hands the agent a usable question when a confirm cannot be shown', async () => {
    const harness = await startHarness({ capabilities: {}, config: { fallback: 'return' } });
    try {
      const call = await callTool(harness.client, {
        name: 'ask_confirm',
        arguments: { question: 'Delete dist/ ?', timeout_ms: 5_000 }
      });
      assert.equal(call.ask.status, 'needs_user_input');
      assert.match(call.ask.next_step, /Do not guess an answer/);
      assert.equal(call.ask.confirmed, null);
    } finally {
      await harness.close();
    }
  });
});
