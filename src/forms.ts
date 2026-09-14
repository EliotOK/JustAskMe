/**
 * Translation layer between this server's transport-agnostic {@link FormQuestion}
 * and the restricted JSON Schema that MCP form elicitation accepts.
 *
 * IMPORTANT — the shape of `requestedSchema` is not free-form. Per the MCP spec
 * and the SDK's own schema (`ElicitRequestFormParamsSchema`), it is a *flat*
 * object of primitives only, and the SDK parses outgoing params through a Zod
 * union that **silently strips unknown keys**. Concretely:
 *
 *   - only `type: "string" | "boolean" | "number" | "integer" | "array"` fields;
 *   - no nested objects, no `$ref`, no `anyOf` at the top level;
 *   - per-property keys are a closed set: `type`, `title`, `description`,
 *     `enum`, `enumNames`, `enum`+`default`, `oneOf`/`anyOf` with `{const,title}`,
 *     `minLength`, `maxLength`, `format`, `minimum`, `maximum`, `minItems`,
 *     `maxItems`, `items`, `default`.
 *
 * We therefore avoid `number`/`integer` fields entirely: Codex has a known
 * issue where numeric elicitation fields degrade into an approval prompt and
 * submit empty content. `min`/`max` for multi-select ride on `minItems`/`maxItems`
 * of an array field, which is a different code path.
 */
import type { ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';
import type { MultiSelectMode } from './config.js';
import type { ChoiceOption, FormAnswer, FormQuestion } from './outcome.js';

export type RequestedSchema = ElicitRequestFormParams['requestedSchema'];

/**
 * The SDK types `requestedSchema` as a large discriminated union, which is
 * painful to build incrementally. We assemble plain objects (documented above)
 * and cast once here; `test/schema.test.ts` round-trips every builder through
 * `ElicitRequestFormParamsSchema.parse()` so any drift from the real schema
 * fails loudly instead of being silently stripped on the wire.
 */
function asRequestedSchema(schema: Record<string, unknown>): RequestedSchema {
  return schema as unknown as RequestedSchema;
}

/** A `elicitation/create` form request plus the human-facing prompt text. */
export interface FormRequest {
  message: string;
  requestedSchema: RequestedSchema;
}

function describeOption(index: number, option: ChoiceOption): string {
  const suffix = option.description ? ` — ${option.description}` : '';
  return `  ${index + 1}. ${option.label}${suffix}`;
}

function optionBlock(options: ChoiceOption[]): string {
  return options.map((option, index) => describeOption(index, option)).join('\n');
}

/**
 * Builds the elicitation request for a question.
 *
 * `enumNames` is set equal to `enum` so clients that honour display names show
 * the label verbatim; per-option descriptions cannot be expressed in the
 * restricted schema, so they are inlined into `message` instead.
 */
export function buildFormRequest(question: FormQuestion, multiSelectMode: MultiSelectMode): FormRequest {
  switch (question.kind) {
    case 'choice': {
      const labels = question.options.map(option => option.label);
      const lines = [question.question, '', 'Options:', optionBlock(question.options), '', 'Choose exactly one option.'];
      if (question.allowFreeText) {
        lines.push('You may add extra detail in the free-text field (optional).');
      }
      if (question.defaultValue !== undefined) {
        lines.push(`Default: ${question.defaultValue}`);
      }

      const choiceProperty: Record<string, unknown> = {
        type: 'string',
        title: 'Your choice',
        description: question.question,
        enum: labels,
        enumNames: labels
      };
      if (question.defaultValue !== undefined) {
        choiceProperty['default'] = question.defaultValue;
      }

      const properties: Record<string, unknown> = { choice: choiceProperty };
      if (question.allowFreeText) {
        properties['free_text'] = {
          type: 'string',
          title: 'Additional notes (optional)',
          description: 'Optional free-text answer or extra context.'
        };
      }

      return {
        message: lines.join('\n'),
        requestedSchema: asRequestedSchema({
          type: 'object',
          properties,
          required: ['choice']
        })
      };
    }

    case 'confirm': {
      const fallback = question.defaultValue ?? false;
      return {
        message: `${question.question}\n\nAnswer yes or no. Default: ${fallback ? 'yes' : 'no'}`,
        requestedSchema: asRequestedSchema({
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              title: question.question,
              description: 'Set to true to confirm, false to decline.',
              default: fallback
            }
          },
          required: ['confirm']
        })
      };
    }

    case 'text': {
      const lines = [question.question];
      if (question.placeholder) lines.push(`Format hint: ${question.placeholder}`);
      if (question.defaultValue !== undefined) lines.push(`Default: ${question.defaultValue}`);

      const textProperty: Record<string, unknown> = {
        type: 'string',
        title: 'Your answer',
        description: question.placeholder ? `${question.question} (${question.placeholder})` : question.question
      };
      if (question.defaultValue !== undefined) {
        textProperty['default'] = question.defaultValue;
      }

      return {
        message: lines.join('\n'),
        requestedSchema: asRequestedSchema({
          type: 'object',
          properties: { text: textProperty },
          required: ['text']
        })
      };
    }

    case 'multi_select': {
      const labels = question.options.map(option => option.label);
      const header = [
        question.question,
        '',
        'Options:',
        optionBlock(question.options),
        '',
        multiSelectMode === 'text'
          ? 'Enter one or more labels separated by commas.'
          : 'Select one or more options.'
      ];
      const bounds: string[] = [];
      if (question.min !== undefined) bounds.push(`at least ${question.min}`);
      if (question.max !== undefined) bounds.push(`at most ${question.max}`);
      if (bounds.length > 0) header.push(`Choose ${bounds.join(' and ')}.`);

      const properties: Record<string, unknown> = {};
      if (multiSelectMode === 'text') {
        properties['choices_text'] = {
          type: 'string',
          title: 'Selections (comma-separated)',
          description: `Comma-separated labels. Allowed: ${labels.join(', ')}`
        };
      } else {
        const arrayProperty: Record<string, unknown> = {
          type: 'array',
          title: 'Your selections',
          description: question.question,
          items: { type: 'string', enum: labels }
        };
        if (question.min !== undefined) arrayProperty['minItems'] = question.min;
        if (question.max !== undefined) arrayProperty['maxItems'] = question.max;
        properties['choices'] = arrayProperty;
      }

      // Deliberately NOT `required`: a client that submits an empty selection
      // should reach our own bounds check and produce a useful message rather
      // than dying inside the SDK's schema validator.
      return {
        message: header.join('\n'),
        requestedSchema: asRequestedSchema({ type: 'object', properties, required: [] })
      };
    }
  }
}

export type InterpretResult = { ok: true; answer: FormAnswer } | { ok: false; detail: string };

function splitLabels(raw: string): string[] {
  return raw
    .split(/[,\n;]/)
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

/** Maps loosely-typed user input back onto canonical option labels. */
function canonicalize(values: string[], options: ChoiceOption[]): string[] {
  const byLower = new Map(options.map(option => [option.label.trim().toLowerCase(), option.label]));
  return values.map(value => byLower.get(value.trim().toLowerCase()) ?? value.trim());
}

/**
 * Validates a client-supplied `content` object against the question that was
 * asked, returning either a normalized answer or a human-readable complaint.
 *
 * Note on leniency: an out-of-enum `choice` is *kept*, not rejected.
 *
 * Where that matters depends on the transport, and it is worth being precise:
 *
 *   - Over MCP elicitation this branch is effectively unreachable. The SDK
 *     validates accepted `content` against `requestedSchema` with Ajv before we
 *     ever see it, so an out-of-enum value surfaces as
 *     `McpError(InvalidParams)` and becomes `status: "invalid_response"`. That
 *     is why `allow_free_text` exists: it is the supported way to let a human
 *     answer with something we did not anticipate.
 *   - Over the loopback HTTP fallback there is no Ajv layer, so the raw value
 *     does reach us and is preserved rather than discarded.
 *
 * Structural problems (missing field, wrong type, out-of-bounds multi-select)
 * are hard errors on every transport.
 */
export function interpretContent(
  question: FormQuestion,
  content: Record<string, string | number | boolean | string[]>,
  multiSelectMode: MultiSelectMode
): InterpretResult {
  switch (question.kind) {
    case 'choice': {
      const raw = content['choice'];
      if (typeof raw !== 'string' || raw.trim() === '') {
        return { ok: false, detail: 'response did not contain a non-empty `choice` string' };
      }
      const selected = canonicalize([raw], question.options);
      const rawFree = content['free_text'];
      const freeText = typeof rawFree === 'string' && rawFree.trim() !== '' ? rawFree.trim() : null;
      return {
        ok: true,
        answer: { selected, freeText, confirmed: null, text: null }
      };
    }

    case 'confirm': {
      const raw = content['confirm'];
      if (typeof raw !== 'boolean') {
        return { ok: false, detail: 'response did not contain a boolean `confirm` value' };
      }
      return { ok: true, answer: { selected: [], freeText: null, confirmed: raw, text: null } };
    }

    case 'text': {
      const raw = content['text'];
      if (typeof raw !== 'string') {
        return { ok: false, detail: 'response did not contain a `text` string' };
      }
      const text = raw.trim();
      if (text === '') {
        return { ok: false, detail: 'the submitted answer was empty' };
      }
      return { ok: true, answer: { selected: [], freeText: null, confirmed: null, text } };
    }

    case 'multi_select': {
      let values: string[];
      if (multiSelectMode === 'text') {
        const raw = content['choices_text'];
        if (typeof raw !== 'string') {
          return { ok: false, detail: 'response did not contain a `choices_text` string' };
        }
        values = splitLabels(raw);
      } else {
        const raw = content['choices'];
        if (raw === undefined || raw === null) {
          values = [];
        } else if (typeof raw === 'string') {
          // Tolerate a client that collapses the array into one string.
          values = splitLabels(raw);
        } else if (Array.isArray(raw)) {
          values = raw.map(entry => String(entry).trim()).filter(entry => entry.length > 0);
        } else {
          return { ok: false, detail: 'response contained a `choices` value that is not an array of strings' };
        }
      }

      const selected = canonicalize(values, question.options);
      // De-duplicate while preserving order.
      const unique = Array.from(new Set(selected));
      const min = question.min ?? 1;
      const max = question.max ?? question.options.length;

      if (unique.length < min) {
        return {
          ok: false,
          detail: `expected at least ${min} selection(s) but received ${unique.length}`
        };
      }
      if (unique.length > max) {
        return {
          ok: false,
          detail: `expected at most ${max} selection(s) but received ${unique.length}`
        };
      }
      return { ok: true, answer: { selected: unique, freeText: null, confirmed: null, text: null } };
    }
  }
}
