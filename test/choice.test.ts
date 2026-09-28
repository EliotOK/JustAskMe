/**
 * Native path: the client supports form elicitation and a human answers.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { interpretContent } from '../src/forms.js';
import type { FormQuestion } from '../src/outcome.js';
import { askResultSchema } from '../src/schemas.js';
import { callTool, delay, startHarness } from './helpers.js';

describe('ask_choice over MCP form elicitation', () => {
  it('returns a selected option after one clickable form', async () => {
    const harness = await startHarness({
      onElicit: () => ({
        action: 'accept',
        content: { choice: 'document' }
      })
    });
    try {
      const call = await callTool(harness.client, {
        name: 'ask_choice',
        arguments: {
          question: 'Which documentation surface should the release notes target?',
          options: [
            { label: 'site', description: 'The public docs site.' },
            { label: 'document', description: 'A DOCUMENT.md in the repo root.' }
          ],
          timeout_ms: 5_000
        }
      });

      assert.equal(call.ask.status, 'answered');
      assert.equal(call.ask.via, 'elicitation');
      assert.equal(call.ask.answer, 'document');
      assert.deepStrictEqual(call.ask.selected, ['document']);
      assert.equal(call.ask.free_text, null);
      assert.equal(call.ask.confirmed, null);
      assert.equal(call.ask.client_elicitation, true);
      assert.equal(call.ask.form_url, null);
      assert.equal(call.isError, false);
      assert.match(call.text, /answer: document/);
      assert.ok(askResultSchema.safeParse(call.ask).success, 'result satisfies the declared output schema');

      // The question really did travel over the wire as a form elicitation.
      assert.equal(harness.seen.length, 1);
      const sent = harness.seen[0]!;
      assert.equal(sent.mode, 'form');
      const schema = sent.requestedSchema as unknown as {
        properties: Record<string, { enum?: string[] }>;
        required?: string[];
      };
      assert.deepStrictEqual(Object.keys(schema.properties), ['choice']);
      assert.deepStrictEqual(schema.properties['choice']?.enum, ['site', 'document', 'Custom reply']);
      assert.deepStrictEqual(schema.required, ['choice']);
      assert.match(sent.message, /site — The public docs site\./, 'option descriptions are inlined into the prompt');
    } finally {
      await harness.close();
    }
  });

  it('returns the first option without opening a text form', async () => {
    const harness = await startHarness({ onElicit: () => ({ action: 'accept', content: { choice: 'first' } }) });
    try {
      const { ask } = await callTool(harness.client, { name: 'ask_choice', arguments: {
        question: 'Which one?', options: [{ label: 'first' }, { label: 'second' }], allow_free_text: true
      } });
      assert.equal(ask.status, 'answered');
      assert.deepStrictEqual(ask.selected, ['first']);
      assert.equal(ask.free_text, null);
      assert.equal(harness.seen.length, 1);
    } finally { await harness.close(); }
  });

  it('omits the custom option when free text is explicitly disabled', async () => {
    const harness = await startHarness({ onElicit: () => ({ action: 'accept', content: { choice: 'first' } }) });
    try {
      const { ask } = await callTool(harness.client, { name: 'ask_choice', arguments: {
        question: 'Which one?', options: [{ label: 'first' }, { label: 'second' }], allow_free_text: false
      } });
      assert.equal(ask.status, 'answered');
      assert.equal(harness.seen.length, 1);
      assert.deepEqual((harness.seen[0]!.requestedSchema.properties['choice'] as { enum?: string[] })?.enum,
        ['first', 'second']);
    } finally { await harness.close(); }
  });

  it('reports invalid_response when the submitted choice is not one of the offered labels', async () => {
    // Not a bug: the SDK validates accepted content against `requestedSchema`
    // with Ajv *before* our own interpretation runs, so an out-of-enum value is
    // stopped there. That is also why `allow_free_text` exists — it is the
    // supported escape hatch for an answer we did not anticipate.
    const harness = await startHarness({
      onElicit: () => ({ action: 'accept', content: { choice: 'the third option, obviously' } })
    });
    try {
      const call = await callTool(harness.client, {
        name: 'ask_choice',
        arguments: {
          question: 'Which one?',
          options: [{ label: 'first' }, { label: 'second' }],
          timeout_ms: 5_000
        }
      });
      assert.equal(call.ask.status, 'invalid_response');
      assert.match(call.ask.message, /does not match the requested schema/);
    } finally {
      await harness.close();
    }
  });

  it('reads an out-of-enum choice leniently on transports without SDK validation', async () => {
    // The loopback fallback has no Ajv layer, so `interpretContent` sees the
    // raw value and deliberately keeps the human's words instead of discarding
    // them. This pins that behaviour directly.
    const question: FormQuestion = {
      kind: 'choice',
      question: 'Which one?',
      options: [{ label: 'first' }, { label: 'second' }],
      allowFreeText: false
    };
    const interpreted = interpretContent(question, { choice: 'the third option, obviously' }, 'array');
    assert.equal(interpreted.ok, true);
    assert.deepStrictEqual(interpreted.ok ? interpreted.answer.selected : [], ['the third option, obviously']);

    const canonical = interpretContent(question, { choice: 'Second' }, 'array');
    assert.equal(canonical.ok, true);
    assert.deepStrictEqual(canonical.ok ? canonical.answer.selected : [], ['second'], 'labels match case-insensitively');
  });

  it('reports invalid_response when the client accepts but submits nothing usable', async () => {
    const harness = await startHarness({ onElicit: () => ({ action: 'accept', content: {} }) });
    try {
      const call = await callTool(harness.client, {
        name: 'ask_choice',
        arguments: { question: 'Which one?', options: [{ label: 'a' }, { label: 'b' }], timeout_ms: 5_000 }
      });
      assert.equal(call.ask.status, 'invalid_response');
      assert.match(call.ask.next_step, /judgement|assumption/);
      assert.ok(askResultSchema.safeParse(call.ask).success);
    } finally {
      await harness.close();
    }
  });
});

describe('ask_confirm over MCP form elicitation', () => {
  it('maps a true submission to confirmed=true and answer="yes"', async () => {
    const harness = await startHarness({ onElicit: () => ({ action: 'accept', content: { confirm: true } }) });
    try {
      const call = await callTool(harness.client, {
        name: 'ask_confirm',
        arguments: { question: 'Delete build/ and dist/? They are regenerable.', timeout_ms: 5_000 }
      });
      assert.equal(call.ask.status, 'answered');
      assert.equal(call.ask.confirmed, true);
      assert.equal(call.ask.answer, 'yes');
      assert.equal(harness.seen[0]?.mode, 'form');
      assert.equal(harness.seen[0]?.requestedSchema.properties['confirm']?.type, 'boolean');
    } finally {
      await harness.close();
    }
  });

  it('maps a false submission to confirmed=false and answer="no"', async () => {
    const harness = await startHarness({ onElicit: () => ({ action: 'accept', content: { confirm: false } }) });
    try {
      const call = await callTool(harness.client, {
        name: 'ask_confirm',
        arguments: { question: 'Proceed?', timeout_ms: 5_000 }
      });
      assert.equal(call.ask.status, 'answered');
      assert.equal(call.ask.confirmed, false);
      assert.equal(call.ask.answer, 'no');
    } finally {
      await harness.close();
    }
  });

  it('reports invalid_response when the submitted boolean is missing', async () => {
    const harness = await startHarness({ onElicit: () => ({ action: 'accept', content: {} }) });
    try {
      const call = await callTool(harness.client, {
        name: 'ask_confirm',
        arguments: { question: 'Proceed?', timeout_ms: 5_000 }
      });
      assert.equal(call.ask.status, 'invalid_response');
    } finally {
      await harness.close();
    }
  });
});

describe('ask_text over MCP form elicitation', () => {
  it('returns the typed string, trimmed', async () => {
    const harness = await startHarness({
      onElicit: () => ({ action: 'accept', content: { text: '  acme/widgets  ' } })
    });
    try {
      const call = await callTool(harness.client, {
        name: 'ask_text',
        arguments: { question: 'Which repository?', placeholder: 'owner/repo', timeout_ms: 5_000 }
      });
      assert.equal(call.ask.status, 'answered');
      assert.equal(call.ask.answer, 'acme/widgets');
      assert.equal(call.ask.selected.length, 0);
    } finally {
      await harness.close();
    }
  });

  it('reports invalid_response for a whitespace-only answer', async () => {
    const harness = await startHarness({ onElicit: () => ({ action: 'accept', content: { text: '   ' } }) });
    try {
      const call = await callTool(harness.client, {
        name: 'ask_text',
        arguments: { question: 'Which?', timeout_ms: 5_000 }
      });
      assert.equal(call.ask.status, 'invalid_response');
      assert.match(call.ask.message, /empty/);
    } finally {
      await harness.close();
    }
  });
});

describe('ask_multi_select over MCP form elicitation', () => {
  it('returns every selected label', async () => {
    const harness = await startHarness({
      onElicit: () => ({ action: 'accept', content: { choices: ['gitlab', 'github'] } })
    });
    try {
      const call = await callTool(harness.client, {
        name: 'ask_multi_select',
        arguments: {
          question: 'Which CI platforms?',
          options: [{ label: 'github' }, { label: 'gitlab' }, { label: 'azure' }],
          min: 1,
          max: 2,
          timeout_ms: 5_000
        }
      });
      assert.equal(call.ask.status, 'answered');
      assert.deepStrictEqual(call.ask.selected, ['gitlab', 'github']);
      assert.equal(call.ask.answer, 'gitlab, github');

      const schema = harness.seen[0]!.requestedSchema as unknown as {
        properties: Record<string, { minItems?: number; maxItems?: number }>;
      };
      assert.equal(schema.properties['choices']?.minItems, 1);
      assert.equal(schema.properties['choices']?.maxItems, 2);
    } finally {
      await harness.close();
    }
  });

  it('reports invalid_response when fewer than `min` options come back', async () => {
    const harness = await startHarness({ onElicit: () => ({ action: 'accept', content: { choices: [] } }) });
    try {
      const call = await callTool(harness.client, {
        name: 'ask_multi_select',
        arguments: {
          question: 'Which CI platforms?',
          options: [{ label: 'github' }, { label: 'gitlab' }],
          min: 2,
          timeout_ms: 5_000
        }
      });
      assert.equal(call.ask.status, 'invalid_response');
      assert.match(call.ask.message, /fewer than 2 items/);
    } finally {
      await harness.close();
    }
  });

  it('reports invalid_response when more than `max` options come back', async () => {
    const harness = await startHarness({
      onElicit: () => ({ action: 'accept', content: { choices: ['github', 'gitlab', 'azure'] } })
    });
    try {
      const call = await callTool(harness.client, {
        name: 'ask_multi_select',
        arguments: {
          question: 'Which CI platforms?',
          options: [{ label: 'github' }, { label: 'gitlab' }, { label: 'azure' }],
          max: 2,
          timeout_ms: 5_000
        }
      });
      assert.equal(call.ask.status, 'invalid_response');
      assert.match(call.ask.message, /more than 2 items/);
    } finally {
      await harness.close();
    }
  });
});


describe('free-text discussion', () => {
  for (const reply of ['Explain the difference first', 'Use a third approach']) {
    it(`opens a second form only for the custom option: ${reply}`, async () => {
      let callCount = 0;
      const harness = await startHarness({ onElicit: (): ElicitResult => {
        callCount += 1;
        return callCount === 1
          ? { action: 'accept', content: { choice: 'Custom reply' } }
          : { action: 'accept', content: { free_text: reply } };
      } });
      try {
        const { ask } = await callTool(harness.client, { name: 'ask_choice', arguments: {
          question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }]
        } });
        assert.equal(ask.status, 'discussion');
        assert.deepEqual(ask.selected, []);
        assert.equal(ask.free_text, reply);
        assert.equal(harness.seen.length, 2);
        assert.deepEqual(Object.keys(harness.seen[0]!.requestedSchema.properties), ['choice']);
        assert.deepEqual(Object.keys(harness.seen[1]!.requestedSchema.properties), ['free_text']);
        assert.match(harness.seen[1]!.message, /^Which approach\?/);
        assert.match(harness.seen[1]!.message, /Original options:\n  1\. A\n  2\. B/);
        assert.match(ask.next_step, /clarification/);
      } finally { await harness.close(); }
    });
  }

  it('shows Chinese text on both forms for a Chinese question', async () => {
    let callCount = 0;
    const harness = await startHarness({ onElicit: (): ElicitResult => {
      callCount += 1;
      return callCount === 1
        ? { action: 'accept', content: { choice: '自定义回答' } }
        : { action: 'accept', content: { free_text: '我想先了解区别' } };
    } });
    try {
      const { ask } = await callTool(harness.client, { name: 'ask_choice', arguments: {
        question: '先处理哪一项？', options: [{ label: '第一项' }, { label: '第二项' }]
      } });
      assert.equal(ask.status, 'discussion');
      assert.equal(ask.free_text, '我想先了解区别');
      assert.equal(harness.seen.length, 2);
      assert.deepEqual((harness.seen[0]!.requestedSchema.properties['choice'] as { enum?: string[] })?.enum,
        ['第一项', '第二项', '自定义回答']);
      assert.match(harness.seen[0]!.message, /选项：/);
      assert.match(harness.seen[1]!.message, /^先处理哪一项？/);
      assert.match(harness.seen[1]!.message, /原选项：\n  1\. 第一项\n  2\. 第二项/);
      assert.match(harness.seen[1]!.message, /请填写自定义回答/);
      assert.doesNotMatch(harness.seen.map(item => item.message).join(' '), /Options:|Your reply|Choose an option/);
    } finally { await harness.close(); }
  });

  it('rejects a blank custom reply', async () => {
    let callCount = 0;
    const harness = await startHarness({ onElicit: (): ElicitResult => {
      callCount += 1;
      return callCount === 1
        ? { action: 'accept', content: { choice: 'Custom reply' } }
        : { action: 'accept', content: { free_text: '   ' } };
    } });
    try {
      const { ask } = await callTool(harness.client, { name: 'ask_choice', arguments: {
        question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }], allow_free_text: true
      } });
      assert.equal(ask.status, 'invalid_response');
      assert.equal(harness.seen.length, 2);
    } finally { await harness.close(); }
  });

  for (const action of ['cancel', 'decline'] as const) {
    it(`propagates ${action} from the custom reply form`, async () => {
      let callCount = 0;
      const harness = await startHarness({ onElicit: () => {
        callCount += 1;
        return callCount === 1
          ? { action: 'accept', content: { choice: 'Custom reply' } }
          : { action };
      } });
      try {
        const { ask } = await callTool(harness.client, { name: 'ask_choice', arguments: {
          question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }], allow_free_text: true
        } });
        assert.equal(ask.status, action === 'cancel' ? 'cancelled' : 'declined');
        assert.equal(harness.seen.length, 2);
      } finally { await harness.close(); }
    });
  }

  it('shares the timeout across both forms', async () => {
    let callCount = 0;
    const harness = await startHarness({ onElicit: async () => {
      callCount += 1;
      if (callCount === 1) {
        await delay(600);
        return { action: 'accept', content: { choice: 'Custom reply' } };
      }
      return await new Promise<never>(() => undefined);
    } });
    try {
      const { ask } = await callTool(harness.client, { name: 'ask_choice', arguments: {
        question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }], allow_free_text: true,
        timeout_ms: 1_200
      } });
      assert.equal(ask.status, 'timeout');
      assert.equal(harness.seen.length, 2);
      assert.ok(ask.elapsed_ms < 1_600, `both forms exceeded the shared budget: ${ask.elapsed_ms}ms`);
    } finally { await harness.close(); }
  });
});
