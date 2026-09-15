/**
 * Schema validation tests.
 *
 * The highest-value test here is {@link roundTrip}: it pushes every schema we
 * build through the *SDK's own* `ElicitRequestFormParamsSchema` and asserts the
 * result is byte-identical. The SDK parses outgoing params through a Zod union
 * whose members use `.strip()`, so an unsupported key (or a mistyped one) is
 * silently dropped rather than rejected — exactly the kind of bug that only
 * shows up as "the form rendered without the options" in production. Deep
 * equality turns that silent drop into a failing test.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ElicitRequestFormParamsSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildFormRequest } from '../src/forms.js';
import type { FormQuestion } from '../src/outcome.js';
import { askResultSchema } from '../src/schemas.js';
import { asAskResult, callTool, startHarness } from './helpers.js';

/** Loose view of a JSON Schema object, for readable assertions in tests. */
type LooseSchema = {
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
};

const CHOICE: FormQuestion = {
  kind: 'choice',
  question: 'Which package manager should this project use?',
  options: [
    { label: 'pnpm', description: 'Fast, strict, disk-efficient.' },
    { label: 'npm', description: 'Zero extra tooling.' }
  ],
  allowFreeText: true,
  defaultValue: 'pnpm'
};

const CONFIRM: FormQuestion = {
  kind: 'confirm',
  question: 'Force-push over origin/main? This rewrites shared history.',
  defaultValue: false
};

const TEXT: FormQuestion = {
  kind: 'text',
  question: 'Which repository should the release be published to?',
  placeholder: 'owner/repo',
  defaultValue: 'acme/widgets'
};

const MULTI: FormQuestion = {
  kind: 'multi_select',
  question: 'Which CI platforms should the workflow target?',
  options: [{ label: 'github' }, { label: 'gitlab' }, { label: 'azure' }],
  min: 1,
  max: 2
};

function roundTrip(question: FormQuestion, mode: 'array' | 'text' = 'array'): LooseSchema {
  const request = buildFormRequest(question, mode);
  const params = {
    mode: 'form' as const,
    message: request.message,
    requestedSchema: request.requestedSchema
  };
  const parsed = ElicitRequestFormParamsSchema.parse(params);
  assert.deepStrictEqual(
    parsed,
    params,
    `the SDK altered the ${question.kind} elicitation params — a key is unsupported and is being stripped`
  );
  return params.requestedSchema as unknown as LooseSchema;
}

describe('elicitation schema round-trip', () => {
  it('ask_choice survives the SDK parser with enum, enumNames and free text intact', () => {
    const schema = roundTrip(CHOICE);
    assert.equal(schema.type, 'object');
    assert.deepStrictEqual(schema.required, []);

    const choice = schema.properties?.['choice'];
    assert.ok(choice, 'choice property is present');
    assert.equal(choice['type'], 'string');
    assert.deepStrictEqual(choice['enum'], ['pnpm', 'npm']);
    assert.deepStrictEqual(choice['enumNames'], ['pnpm', 'npm'], 'enumNames must not be stripped');
    assert.equal(choice['default'], 'pnpm');

    const freeText = schema.properties?.['free_text'];
    assert.ok(freeText, 'free_text property is present when allow_free_text is set');
    assert.equal(freeText['type'], 'string');
  });

  it('omits free_text when allow_free_text is not requested', () => {
    const schema = roundTrip({ ...CHOICE, allowFreeText: false });
    assert.equal(schema.properties?.['free_text'], undefined);
  });

  it('ask_confirm survives the SDK parser as a boolean field', () => {
    const schema = roundTrip(CONFIRM);
    assert.deepStrictEqual(schema.required, ['confirm']);
    assert.equal(schema.properties?.['confirm']?.['type'], 'boolean');
    assert.equal(schema.properties?.['confirm']?.['default'], false);
  });

  it('ask_confirm without a default advertises no default and no "Default:" hint', () => {
    const request = buildFormRequest({ kind: 'confirm', question: 'Deploy to production now?' }, 'array');
    roundTrip({ kind: 'confirm', question: 'Deploy to production now?' });
    assert.doesNotMatch(request.message, /Default:/);
    assert.equal((request.requestedSchema as unknown as LooseSchema).properties?.['confirm']?.['default'], undefined);
  });

  it('ask_text survives the SDK parser as a string field', () => {
    const schema = roundTrip(TEXT);
    assert.deepStrictEqual(schema.required, ['text']);
    assert.equal(schema.properties?.['text']?.['type'], 'string');
    assert.equal(schema.properties?.['text']?.['default'], 'acme/widgets');
  });

  it('ask_multi_select uses an enum array with bounds, never a numeric field', () => {
    const schema = roundTrip(MULTI);
    const choices = schema.properties?.['choices'];
    assert.ok(choices, 'choices property is present');
    assert.equal(choices['type'], 'array');
    assert.deepStrictEqual(choices['items'], { type: 'string', enum: ['github', 'gitlab', 'azure'] });
    assert.equal(choices['minItems'], 1);
    assert.equal(choices['maxItems'], 2);

    // Regression guard: Codex mishandles numeric elicitation fields, so no
    // field in any schema we emit may be number/integer.
    for (const property of Object.values(schema.properties ?? {})) {
      assert.notEqual(property['type'], 'number');
      assert.notEqual(property['type'], 'integer');
    }
  });

  it('ask_multi_select degrades to a text field in text mode', () => {
    const schema = roundTrip(MULTI, 'text');
    assert.equal(schema.properties?.['choices']?.['type'], undefined);
    assert.equal(schema.properties?.['choices_text']?.['type'], 'string');
  });

  it('does not mark the multi-select field required, so an empty answer reaches our own bounds check', () => {
    const schema = roundTrip(MULTI);
    assert.deepStrictEqual(schema.required, []);
  });
});

describe('tool definitions', () => {
  it('publishes all five tools with JSON Schemas for input and output', async () => {
    const harness = await startHarness();
    try {
      const { tools } = await harness.client.listTools();
      assert.deepStrictEqual(
        tools.map(tool => tool.name).sort(),
        ['ask_choice', 'ask_confirm', 'ask_multi_select', 'ask_text', 'human_input_status']
      );

      const choice = tools.find(tool => tool.name === 'ask_choice');
      assert.ok(choice, 'ask_choice is listed');
      const input = choice.inputSchema as unknown as LooseSchema;
      for (const field of ['question', 'options', 'default', 'allow_free_text', 'timeout_ms']) {
        assert.ok(input.properties?.[field], `ask_choice input schema declares ${field}`);
      }
      assert.deepStrictEqual(input.required, ['question', 'options']);

      const options = input.properties?.['options'] as unknown as Record<string, unknown>;
      assert.equal(options['type'], 'array');
      assert.equal(options['minItems'], 2);
      assert.equal(options['maxItems'], 25);

      assert.ok(choice.outputSchema, 'ask_choice declares an output schema');
      const output = choice.outputSchema as unknown as LooseSchema;
      assert.ok(output.properties?.['status'], 'output schema declares status');
      assert.ok(output.properties?.['next_step'], 'output schema declares next_step');
      for (const tool of tools.filter(entry => entry.name.startsWith('ask_'))) {
        assert.ok(tool.annotations?.readOnlyHint, `${tool.name} is annotated read-only`);
      }
    } finally {
      await harness.close();
    }
  });
});

describe('argument validation', () => {
  it('rejects duplicate option labels with an actionable error result', async () => {
    const harness = await startHarness();
    try {
      const result = await harness.client.callTool({
        name: 'ask_choice',
        arguments: { question: 'Pick one', options: [{ label: 'A' }, { label: 'A' }] }
      });
      assert.equal(result.isError, true);
      const parsed = asAskResult(result);
      assert.equal(parsed.status, 'error');
      assert.match(parsed.message, /duplicate labels/);
      assert.ok(askResultSchema.safeParse(parsed).success, 'error results still satisfy the output schema');
    } finally {
      await harness.close();
    }
  });

  it('rejects a default that does not match any option label', async () => {
    const harness = await startHarness();
    try {
      const result = await harness.client.callTool({
        name: 'ask_choice',
        arguments: { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }], default: 'C' }
      });
      assert.equal(result.isError, true);
      assert.match(asAskResult(result).message, /must exactly match one of the option labels/);
    } finally {
      await harness.close();
    }
  });

  it('rejects min greater than max on ask_multi_select', async () => {
    const harness = await startHarness();
    try {
      const result = await harness.client.callTool({
        name: 'ask_multi_select',
        arguments: { question: 'Pick some', options: [{ label: 'A' }, { label: 'B' }], min: 2, max: 1 }
      });
      assert.equal(result.isError, true);
      assert.match(asAskResult(result).message, /must not exceed/);
    } finally {
      await harness.close();
    }
  });

  it('rejects max larger than the option count', async () => {
    const harness = await startHarness();
    try {
      const result = await harness.client.callTool({
        name: 'ask_multi_select',
        arguments: { question: 'Pick some', options: [{ label: 'A' }, { label: 'B' }], max: 5 }
      });
      assert.equal(result.isError, true);
      assert.match(asAskResult(result).message, /cannot exceed the number of options/);
    } finally {
      await harness.close();
    }
  });

  it('lets the MCP layer reject structurally invalid arguments', async () => {
    const harness = await startHarness();
    try {
      // A single option is not a choice; the input schema enforces >= 2.
      // Depending on the SDK version this surfaces either as a JSON-RPC error
      // or as an `isError` tool result — both are acceptable, silently
      // proceeding is not.
      const single = await callTool(harness.client, {
        name: 'ask_choice',
        arguments: { question: 'Pick one', options: [{ label: 'A' }] }
      })
        .then(call => ({ rejected: false, call }))
        .catch(() => ({ rejected: true, call: undefined }));
      assert.ok(
        single.rejected || single.call?.isError === true,
        'a one-option ask_choice must not be accepted'
      );

      // `options` is required.
      const missing = await callTool(harness.client, {
        name: 'ask_choice',
        arguments: { question: 'Pick one' }
      })
        .then(call => ({ rejected: false, call }))
        .catch(() => ({ rejected: true, call: undefined }));
      assert.ok(
        missing.rejected || missing.call?.isError === true,
        'ask_choice without options must not be accepted'
      );
    } finally {
      await harness.close();
    }
  });
});
