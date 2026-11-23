/**
 * Native path: the client supports form elicitation and a human answers.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { interpretContent } from '../src/forms.js';
import type { FormQuestion } from '../src/outcome.js';
import { askResultSchema } from '../src/schemas.js';
import { callTool, startHarness } from './helpers.js';

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
      assert.deepStrictEqual(Object.keys(schema.properties), ['choice', 'free_text']);
      assert.deepStrictEqual(schema.properties['choice']?.enum, ['site', 'document']);
      assert.deepStrictEqual(schema.required, []);
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


describe('single-card replies', () => {
  const cases: { name: string; content: Record<string, string>; status: string; selected: string[]; text: string | null }[] = [
    { name: 'text only', content: { free_text: '先解释区别' }, status: 'discussion', selected: [], text: '先解释区别' },
    { name: 'choice with a note', content: { choice: 'B', free_text: '  仅当前账号  ' }, status: 'answered', selected: ['B'], text: '仅当前账号' },
    { name: 'no input', content: {}, status: 'invalid_response', selected: [], text: null },
    { name: 'blank input', content: { free_text: '   ' }, status: 'invalid_response', selected: [], text: null }
  ];
  for (const row of cases) {
    it(row.name, async () => {
      const harness = await startHarness({ onElicit: () => ({ action: 'accept', content: row.content }) });
      try {
        const { ask } = await callTool(harness.client, { name: 'ask_choice', arguments: {
          question: '先处理哪一项？', options: [{ label: 'A' }, { label: 'B' }]
        } });
        assert.equal(harness.seen.length, 1);
        assert.equal(harness.seen[0]!.requestedSchema.properties['free_text']?.title, '你的回答或补充');
        assert.equal(ask.status, row.status);
        assert.deepEqual(ask.selected, row.selected);
        assert.equal(ask.free_text, row.text);
      } finally { await harness.close(); }
    });
  }
});
