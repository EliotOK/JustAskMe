/**
 * Loopback-HTTP fallback, exercised end to end.
 *
 * These tests drive the fallback the way a human would: read the URL the server
 * printed to stderr, open it, submit the form, and check that the blocked tool
 * call resolves with the answer. They also cover the parts that make the
 * fallback safe to run — token enforcement and self-shutdown.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
  CallToolResult,
  ClientCapabilities
} from '@modelcontextprotocol/sdk/types.js';
import { serveForm } from '../src/http-form.js';
import type { FormQuestion } from '../src/outcome.js';
import { asAskResult, callTool, delay, startHarness, textOf } from './helpers.js';

const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{32}/;

interface CapturedStderr {
  lines: string[];
  restore: () => void;
}

/** Mirrors stderr while also forwarding it, so the URL stays debug-visible. */
function captureStderr(): CapturedStderr {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return original(chunk, ...rest);
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stderr.write = original as typeof process.stderr.write;
    }
  };
}

async function waitForUrl(lines: string[], timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of lines) {
      const match = URL_PATTERN.exec(line);
      if (match) return match[0];
    }
    await delay(20);
  }
  throw new Error(`the fallback URL never appeared on stderr within ${timeoutMs}ms`);
}

function endpoint(url: string, pathname: string): string {
  const parsed = new URL(url);
  parsed.pathname = pathname;
  return parsed.toString();
}

async function submit(url: string, payload: unknown): Promise<Response> {
  return await fetch(endpoint(url, '/answer'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

describe('http fallback', () => {
  it('serves a form, enforces the token, and returns the submitted answer', async () => {
    const captured = captureStderr();
    const harness = await startHarness({
      capabilities: {},
      config: { fallback: 'http', httpOpenBrowser: false, httpHost: '127.0.0.1', httpPort: 0, timeoutMs: 20_000 }
    });
    try {
      const pending = harness.client.callTool(
        {
          name: 'ask_confirm',
          arguments: { question: 'Proceed with the irreversible schema migration?', timeout_ms: 20_000 }
        },
        CallToolResultSchema
      ) as unknown as Promise<CallToolResult>;
      pending.catch(() => undefined);

      const url = await waitForUrl(captured.lines);

      // A wrong token must not be servable, even on loopback.
      const wrongToken = endpoint(url, '/').replace(/token=[0-9a-f]{32}/, `token=${'f'.repeat(32)}`);
      const forbidden = await fetch(wrongToken);
      assert.equal(forbidden.status, 403);

      const page = await fetch(url);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /Proceed with the irreversible schema migration\?/);
      // `required` keeps an empty submit in the browser instead of producing a
      // bogus "answered" with no boolean.
      assert.match(html, /name="confirm" value="true" required/);
      assert.match(html, /name="confirm" value="false" required/);
      assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/, 'the page must not pull in external resources');

      const posted = await submit(url, { cancelled: false, values: { confirm: 'true' } });
      assert.equal(posted.status, 200);

      const result = asAskResult(await pending);
      assert.equal(result.status, 'answered');
      assert.equal(result.via, 'http_form');
      assert.equal(result.confirmed, true);
      assert.equal(result.answer, 'yes');
      assert.equal(result.form_url, url);
      assert.equal(result.client_elicitation, false);
    } finally {
      captured.restore();
      await harness.close();
    }
  });

  it('reports cancellation when the user closes the form without answering', async () => {
    const captured = captureStderr();
    const harness = await startHarness({
      capabilities: {},
      config: { fallback: 'http', httpOpenBrowser: false, timeoutMs: 20_000 }
    });
    try {
      const pending = harness.client.callTool(
        {
          name: 'ask_choice',
          arguments: {
            question: 'Which environment?',
            options: [{ label: 'staging' }, { label: 'production' }],
            timeout_ms: 20_000
          }
        },
        CallToolResultSchema
      ) as unknown as Promise<CallToolResult>;
      pending.catch(() => undefined);

      const url = await waitForUrl(captured.lines);
      await submit(url, { cancelled: true, values: {} });

      const result = asAskResult(await pending);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.via, 'http_form');
    } finally {
      captured.restore();
      await harness.close();
    }
  });

  it('reports invalid_response when the form is submitted empty', async () => {
    const captured = captureStderr();
    const harness = await startHarness({
      capabilities: {},
      config: { fallback: 'http', httpOpenBrowser: false, timeoutMs: 20_000 }
    });
    try {
      const pending = harness.client.callTool(
        {
          name: 'ask_multi_select',
          arguments: {
            question: 'Which platforms?',
            options: [{ label: 'windows' }, { label: 'linux' }],
            min: 1,
            timeout_ms: 20_000
          }
        },
        CallToolResultSchema
      ) as unknown as Promise<CallToolResult>;
      pending.catch(() => undefined);

      const url = await waitForUrl(captured.lines);
      await submit(url, { cancelled: false, values: {} });

      const result = asAskResult(await pending);
      assert.equal(result.status, 'invalid_response');
      assert.equal(result.via, 'http_form');
      assert.match(result.message, /at least 1 selection/);
    } finally {
      captured.restore();
      await harness.close();
    }
  });

  it('computes multi-select answers from checkbox submissions', async () => {
    const captured = captureStderr();
    const harness = await startHarness({
      capabilities: {},
      config: { fallback: 'http', httpOpenBrowser: false, timeoutMs: 20_000 }
    });
    try {
      const pending = harness.client.callTool(
        {
          name: 'ask_multi_select',
          arguments: {
            question: 'Which platforms should the build target?',
            options: [{ label: 'windows' }, { label: 'linux' }, { label: 'macos' }],
            min: 1,
            max: 2,
            timeout_ms: 20_000
          }
        },
        CallToolResultSchema
      ) as unknown as Promise<CallToolResult>;
      pending.catch(() => undefined);

      const url = await waitForUrl(captured.lines);
      const page = await (await fetch(url)).text();
      assert.match(page, /name="choices" value="windows" required/);
      assert.match(page, /type="checkbox"/);

      await submit(url, { cancelled: false, values: { choices: ['windows', 'macos'] } });

      const result = asAskResult(await pending);
      assert.equal(result.status, 'answered');
      assert.deepStrictEqual(result.selected, ['windows', 'macos']);
      assert.equal(result.answer, 'windows, macos');
    } finally {
      captured.restore();
      await harness.close();
    }
  });

  it('times out and tears the form down when nobody submits', async () => {
    const question: FormQuestion = {
      kind: 'text',
      question: 'Which channel should the announcement go to?',
      placeholder: '#release'
    };
    const started = Date.now();
    const outcome = await serveForm(question, 'array', {
      timeoutMs: 250,
      host: '127.0.0.1',
      port: 0,
      openBrowser: false
    });
    const elapsed = Date.now() - started;

    assert.equal(outcome.reason, 'timeout');
    assert.deepStrictEqual(outcome.values, {});
    assert.match(outcome.url, URL_PATTERN);
    assert.ok(elapsed >= 200 && elapsed < 5_000, `unexpected duration ${elapsed}ms`);

    // The server must be gone: nothing is listening on that port any more.
    await assert.rejects(fetch(outcome.url), 'the fallback server should have shut down');
  });
});

describe('human_input_status', () => {
  it('reports the negotiated capability and the effective fallback', async () => {
    const harness = await startHarness({ capabilities: {}, config: { fallback: 'return' } });
    try {
      // This tool is a plain diagnostic: text content, no output schema.
      const raw = (await harness.client.callTool(
        { name: 'human_input_status', arguments: { verbose: true } },
        CallToolResultSchema
      )) as unknown as CallToolResult;
      const report = JSON.parse(textOf(raw)) as Record<string, unknown>;
      assert.equal(report['client_supports_form_elicitation'], false);
      assert.equal(report['fallback_mode'], 'return');
      assert.deepStrictEqual(report['tools'], [
        'ask_choice',
        'ask_confirm',
        'ask_text',
        'ask_multi_select',
        'human_input_status'
      ]);
    } finally {
      await harness.close();
    }
  });
});

describe('legacy elicitation capability', () => {
  // Pre-2025-11 clients declare the bare legacy shape `elicitation: {}`. The
  // SDK normalizes that to `{ form: {} }`, and its own gate for
  // `elicitation/create` is a truthy `elicitation` object — so these clients
  // must be served, not routed to the fallback.
  const LEGACY: ClientCapabilities = { elicitation: {} };

  it('reports a legacy `elicitation: {}` client as elicitation-capable', async () => {
    const harness = await startHarness({ capabilities: LEGACY, config: { fallback: 'return' } });
    try {
      const raw = (await harness.client.callTool(
        { name: 'human_input_status', arguments: {} },
        CallToolResultSchema
      )) as unknown as CallToolResult;
      const report = JSON.parse(textOf(raw)) as Record<string, unknown>;
      assert.equal(report['client_supports_form_elicitation'], true);
    } finally {
      await harness.close();
    }
  });

  it('answers ask_choice over elicitation for a legacy `elicitation: {}` client', async () => {
    const harness = await startHarness({
      capabilities: LEGACY,
      config: { fallback: 'return' },
      onElicit: () => ({ action: 'accept', content: { choice: 'http' } })
    });
    try {
      const result = asAskResult(
        await harness.client.callTool({
          name: 'ask_choice',
          arguments: { question: 'Which protocol?', options: [{ label: 'http' }, { label: 'grpc' }] }
        }, CallToolResultSchema)
      );
      assert.equal(result.status, 'answered');
      assert.equal(result.via, 'elicitation');
      assert.equal(result.answer, 'http');
    } finally {
      await harness.close();
    }
  });
});
