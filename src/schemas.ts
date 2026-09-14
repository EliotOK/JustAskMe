/**
 * Input schemas (shown to the model as JSON Schema) and the uniform output
 * schema for every `ask_*` tool.
 *
 * The `describe()` text is not decoration: it is the only steering the model
 * gets at call time, so each field states what it is *and* the discipline
 * around it.
 */
import { z } from 'zod';

export const optionSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(200)
    .describe('Short label shown to the user. Keep it under ~60 characters; it is also the returned value.'),
  description: z
    .string()
    .max(1000)
    .optional()
    .describe('Optional one-line explanation of this option, shown next to the label to help the user decide.')
});

const timeoutField = z
  .number()
  .int()
  .min(1_000)
  .max(3_600_000)
  .optional()
  .describe(
    'Optional override, in milliseconds, for how long to wait for the user. Defaults to the server setting (HIM_TIMEOUT_MS, 300000).'
  );

export const askChoiceInputSchema = {
  question: z
    .string()
    .min(1)
    .max(2_000)
    .describe(
      'The single decision you need the user to make. State it as a direct question and include the context needed to answer it without re-reading the whole task.'
    ),
  options: z
    .array(optionSchema)
    .min(2)
    .max(25)
    .describe(
      'Two to five mutually exclusive options is ideal. Every option must be genuinely viable; do not pad the list. Use ask_confirm for yes/no instead of a two-item choice.'
    ),
  default: z
    .string()
    .max(200)
    .optional()
    .describe('Optional label of the recommended option. Must exactly match one of the provided labels.'),
  allow_free_text: z
    .boolean()
    .optional()
    .describe(
      'Set true to also show an optional free-text field alongside the options, letting the user add nuance or an answer you did not list.'
    ),
  timeout_ms: timeoutField
};

export const askConfirmInputSchema = {
  question: z
    .string()
    .min(1)
    .max(2_000)
    .describe(
      'A question answerable with yes/no. For destructive or irreversible actions, name the exact target and consequence so the user can judge the risk.'
    ),
  default: z
    .boolean()
    .optional()
    .describe('Optional pre-selected answer. Omit it for genuinely open decisions; pre-selecting a destructive action is discouraged.'),
  timeout_ms: timeoutField
};

export const askTextInputSchema = {
  question: z
    .string()
    .min(1)
    .max(2_000)
    .describe('The open-ended question to ask. Prefer ask_choice when the reasonable answers are enumerable.'),
  placeholder: z
    .string()
    .max(500)
    .optional()
    .describe('Optional format hint shown inside the input, e.g. "owner/repo" or "an absolute Windows path".'),
  default: z.string().max(2_000).optional().describe('Optional pre-filled answer the user can accept or edit.'),
  timeout_ms: timeoutField
};

export const askMultiSelectInputSchema = {
  question: z
    .string()
    .min(1)
    .max(2_000)
    .describe('The question whose answer is a subset of the listed options. Say explicitly whether the choices are independent.'),
  options: z
    .array(optionSchema)
    .min(2)
    .max(25)
    .describe('The candidate items. The user may select more than one.'),
  min: z
    .number()
    .int()
    .min(0)
    .max(25)
    .optional()
    .describe('Minimum number of selections required. Defaults to 1.'),
  max: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe('Maximum number of selections allowed. Defaults to the number of options.'),
  timeout_ms: timeoutField
};

/** The single result shape shared by all four question tools. */
export const askResultShape = {
  tool: z.string().describe('Name of the tool that produced this result.'),
  status: z
    .enum([
      'answered',
      'declined',
      'cancelled',
      'timeout',
      'unsupported',
      'invalid_response',
      'needs_user_input',
      'error'
    ])
    .describe(
      'Outcome. Only `answered` carries a usable answer. `needs_user_input` means you must ask the user yourself, in chat, using the question and options in `message`.'
    ),
  via: z.enum(['elicitation', 'http_form', 'none']).describe('Channel that produced the outcome.'),
  question: z.string().describe('The question as it was asked.'),
  message: z.string().describe('Human-readable summary, including options when the question is still unanswered.'),
  next_step: z.string().describe('What you should do next. Follow it.'),
  answer: z.string().nullable().describe('The answer as a string: chosen label, "yes"/"no", or the typed text.'),
  free_text: z.string().nullable().describe('Optional free-text note supplied alongside a choice.'),
  selected: z.array(z.string()).describe('Selected labels; exactly one for ask_choice, N for ask_multi_select.'),
  confirmed: z.boolean().nullable().describe('ask_confirm only: true for yes, false for no.'),
  client_elicitation: z
    .boolean()
    .describe('Whether the connected client declared MCP form-elicitation support during initialize.'),
  fallback: z.string().describe('Configured fallback mode (HIM_FALLBACK).'),
  auto_reject_suspected: z
    .boolean()
    .describe('True when a decline came back so fast that the client probably auto-rejected rather than asking the user.'),
  elapsed_ms: z.number().describe('Wall-clock time spent waiting for the user, in milliseconds.'),
  form_url: z.string().nullable().describe('Loopback form URL, when the http fallback served this question.')
} as const;

/** Structured-content validator for the uniform tool result. */
export const askResultSchema = z.object(askResultShape);

export const statusInputSchema = {
  verbose: z
    .boolean()
    .optional()
    .describe('Include per-connection diagnostics such as the raw client capabilities and the resolved configuration.')
};
