/**
 * The single, uniform result shape every `ask_*` tool returns.
 *
 * Keeping one shape (instead of four) means the agent only has to learn one
 * contract, and every failure mode has an explicit `status` rather than being
 * smuggled through an exception or an empty string.
 */
export type AskStatus =
  /** The human answered; `answer`/`selected`/`confirmed` are authoritative. */
  | 'answered'
  /** The human (or the client) rejected the question. */
  | 'declined'
  /** The human dismissed it, or the agent's tool call was cancelled. */
  | 'cancelled'
  /** Nobody answered within the deadline. */
  | 'timeout'
  /** The client never declared MCP form-elicitation support. */
  | 'unsupported'
  /** The client answered, but the payload did not satisfy the question. */
  | 'invalid_response'
  /** Fallback mode `return`: hand the question to the agent to ask in chat. */
  | 'needs_user_input'
  /** Unexpected server-side failure. */
  | 'error';

/** Which channel actually produced (or failed to produce) the answer. */
export type AnswerVia = 'elicitation' | 'http_form' | 'none';

/** Machine-readable description of a question, independent of transport. */
export interface ChoiceOption {
  label: string;
  description?: string;
}

export type FormQuestion =
  | {
      kind: 'choice';
      question: string;
      options: ChoiceOption[];
      defaultValue?: string;
      allowFreeText: boolean;
    }
  | {
      kind: 'confirm';
      question: string;
      defaultValue?: boolean;
    }
  | {
      kind: 'text';
      question: string;
      placeholder?: string;
      defaultValue?: string;
    }
  | {
      kind: 'multi_select';
      question: string;
      options: ChoiceOption[];
      min?: number;
      max?: number;
    };

/** A parsed, validated answer to a {@link FormQuestion}. */
export interface FormAnswer {
  /** Selected label(s). Exactly one for `choice`, empty for `confirm`/`text`. */
  selected: string[];
  /** Free-text companion for `choice` when `allowFreeText` was set. */
  freeText: string | null;
  /** `confirm` only. */
  confirmed: boolean | null;
  /** `text` only. */
  text: string | null;
}

/** Why an elicitation attempt did not produce an answer. */
export type ElicitationFailure =
  | 'no_capability'
  | 'timeout'
  | 'aborted'
  | 'invalid_response'
  | 'transport_error';

export type ElicitationOutcome =
  | { ok: true; action: 'accept'; content: Record<string, string | number | boolean | string[]> }
  | { ok: true; action: 'decline' | 'cancel' }
  | { ok: false; reason: ElicitationFailure; detail: string };

/** The uniform tool result. Every field is always present. */
export interface AskResult {
  tool: string;
  status: AskStatus;
  via: AnswerVia;
  question: string;
  /** One-line, human-readable summary. Safe to show the user verbatim. */
  message: string;
  /** Explicit instruction for the agent about what to do next. */
  next_step: string;
  /** Primary answer as a string: chosen label, confirmed `"yes"`/`"no"`, or text. */
  answer: string | null;
  free_text: string | null;
  /** Selected labels; one entry for `choice`, N for `multi_select`. */
  selected: string[];
  /** `confirm` only. */
  confirmed: boolean | null;
  /** Whether the connected client declared `capabilities.elicitation.form`. */
  client_elicitation: boolean;
  /** The configured fallback mode. */
  fallback: string;
  /**
   * True when `declined` arrived suspiciously fast, which usually means the
   * client auto-rejected instead of asking the human.
   */
  auto_reject_suspected: boolean;
  elapsed_ms: number;
  /** Loopback URL, when the `http` fallback served this question. */
  form_url: string | null;
}

/** Builds an all-defaults result; callers override the interesting fields. */
export function emptyResult(tool: string, question: string, fallback: string): AskResult {
  return {
    tool,
    status: 'error',
    via: 'none',
    question,
    message: '',
    next_step: '',
    answer: null,
    free_text: null,
    selected: [],
    confirmed: null,
    client_elicitation: false,
    fallback,
    auto_reject_suspected: false,
    elapsed_ms: 0,
    form_url: null
  };
}
