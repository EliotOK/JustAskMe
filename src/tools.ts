/**
 * Tool registration and the single "ask a human" pipeline.
 *
 * Every tool funnels into {@link runQuestion}, so the four tools differ only in
 * how the question is shaped and how the answer is read back:
 *
 *   1. native MCP form elicitation (`elicitation/create`, mode `form`);
 *   2. the configured fallback — non-blocking `return`, loopback `http` form,
 *      or a hard error with `off`.
 *
 * Nothing here mutates the workspace, so all question tools are annotated
 * read-only; that keeps them out of approval prompts in clients that gate
 * side-effecting tools.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations
} from '@modelcontextprotocol/sdk/types.js';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import type { ServerConfig } from './config.js';
import { clientSupportsFormElicitation, requestFormInput } from './elicitation.js';
import { buildFormRequest, interpretContent } from './forms.js';
import { serveForm } from './http-form.js';
import { log } from './logger.js';
import type { AnswerVia, AskResult, AskStatus, FormAnswer, FormQuestion } from './outcome.js';
import { emptyResult } from './outcome.js';
import {
  askChoiceInputSchema,
  askConfirmInputSchema,
  askMultiSelectInputSchema,
  askResultShape,
  askTextInputSchema,
  statusInputSchema
} from './schemas.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Asking is not a filesystem mutation, but it does reach a human. Marking it
 * read-only avoids spurious approval prompts; `openWorldHint` stays true
 * because the answer is not derivable from the workspace.
 */
const QUESTION_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
};

/** A tool result plus the MCP-level error flag. */
export interface AskOutcome {
  result: AskResult;
  isError: boolean;
}

function optionLines(question: FormQuestion): string[] {
  if (question.kind !== 'choice' && question.kind !== 'multi_select') return [];
  return question.options.map(
    (option, index) => `  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`
  );
}

/**
 * Renders the question so the agent can reproduce it verbatim in chat when
 * elicitation is unavailable. This is the entire value of the `return`
 * fallback: a faithful, structured hand-off instead of a vague instruction.
 */
export function renderForAgent(question: FormQuestion): string {
  const header: string[] = [question.question];
  const options = optionLines(question);

  switch (question.kind) {
    case 'choice':
      header.push('', 'Options:', ...options);
      if (question.allowFreeText) header.push('', '(the user may also add free-text notes)');
      if (question.defaultValue !== undefined) header.push(`(suggested default: ${question.defaultValue})`);
      break;
    case 'confirm':
      header.push('(answer yes or no)');
      break;
    case 'text':
      if (question.placeholder) header.push(`(expected format: ${question.placeholder})`);
      if (question.defaultValue !== undefined) header.push(`(suggested default: ${question.defaultValue})`);
      break;
    case 'multi_select': {
      header.push('', 'Options:', ...options, '', 'The user may select more than one.');
      const bounds: string[] = [];
      if (question.min !== undefined) bounds.push(`at least ${question.min}`);
      if (question.max !== undefined) bounds.push(`at most ${question.max}`);
      if (bounds.length > 0) header.push(`Choose ${bounds.join(' and ')}.`);
      break;
    }
  }
  return header.join('\n');
}

function answerText(question: FormQuestion, answer: FormAnswer): string {
  switch (question.kind) {
    case 'choice':
      return answer.selected[0] ?? '';
    case 'confirm':
      return answer.confirmed === true ? 'yes' : 'no';
    case 'text':
      return answer.text ?? '';
    case 'multi_select':
      return answer.selected.join(', ');
  }
}

function withAnswer(
  base: AskResult,
  question: FormQuestion,
  answer: FormAnswer,
  via: AnswerVia,
  started: number
): AskOutcome {
  const text = answerText(question, answer);
  const note = answer.freeText ? ` The user added: "${answer.freeText}"` : '';
  return {
    result: {
      ...base,
      status: 'answered',
      via,
      answer: text,
      free_text: answer.freeText,
      selected: answer.selected,
      confirmed: answer.confirmed,
      elapsed_ms: Date.now() - started,
      message: `User answered: ${text}.${note}`,
      next_step: 'Continue with this answer. Do not ask this question again.'
    },
    isError: false
  };
}

function withStatus(
  base: AskResult,
  status: AskStatus,
  via: AnswerVia,
  started: number,
  message: string,
  nextStep: string,
  isError = false
): AskOutcome {
  return {
    result: { ...base, status, via, elapsed_ms: Date.now() - started, message, next_step: nextStep },
    isError
  };
}

function unanswerable(
  base: AskResult,
  question: FormQuestion,
  started: number,
  prefix: string
): AskOutcome {
  return {
    result: {
      ...base,
      status: 'needs_user_input',
      via: 'none',
      elapsed_ms: Date.now() - started,
      message: `${prefix}\n\n${renderForAgent(question)}`,
      next_step:
        'Reproduce this question and its options to the user verbatim in your next message, wait for their reply, then continue. Do not guess an answer or silently pick a default.'
    },
    isError: false
  };
}

interface AskArgs {
  server: McpServer;
  config: ServerConfig;
  extra: Extra;
}

/**
 * The one path every question takes. Returns instead of throwing: an
 * unanswerable question is a normal outcome, not a crash.
 */
export async function runQuestion(
  tool: string,
  question: FormQuestion,
  timeoutMs: number,
  args: AskArgs
): Promise<AskOutcome> {
  const { server, config, extra } = args;
  const started = Date.now();
  const base = emptyResult(tool, question.question, config.fallback);
  base.client_elicitation = clientSupportsFormElicitation(server);

  let failure: string | null = null;

  // ---- 1. Native MCP form elicitation -------------------------------------
  if (base.client_elicitation) {
    const request = buildFormRequest(question, config.multiSelectMode);
    const outcome = await requestFormInput(server, request, { timeoutMs, signal: extra.signal });

    if (outcome.ok && outcome.action === 'accept') {
      const interpreted = interpretContent(question, outcome.content, config.multiSelectMode);
      if (interpreted.ok) {
        return withAnswer(base, question, interpreted.answer, 'elicitation', started);
      }
      log.warn(`unusable elicitation response for ${tool}: ${interpreted.detail}`);
      return withStatus(
        base,
        'invalid_response',
        'elicitation',
        started,
        `The client submitted an answer, but it could not be read: ${interpreted.detail}. Raw response: ${JSON.stringify(outcome.content)}`,
        'Either re-ask with a simpler question (fewer options, no free text) or proceed using your own judgement — and tell the user which assumption you made.'
      );
    }

    if (outcome.ok && outcome.action === 'decline') {
      const elapsed = Date.now() - started;
      if (elapsed < config.autoRejectThresholdMs && config.fallback !== 'off') {
        const suspected = unanswerable(
          base,
          question,
          started,
          `The MCP client returned "decline" after only ${elapsed}ms, which almost certainly means it is auto-rejecting elicitation instead of prompting the user (in Codex, check approval_policy.granular.mcp_elicitations). Nobody saw this question.`
        );
        suspected.result.auto_reject_suspected = true;
        return suspected;
      }
      return withStatus(
        base,
        'declined',
        'elicitation',
        started,
        'The user declined to answer.',
        'Do not ask again. Choose the most conservative option, state the assumption you made, and continue — or stop and report that a decision is required.'
      );
    }

    if (outcome.ok && outcome.action === 'cancel') {
      return withStatus(
        base,
        'cancelled',
        'elicitation',
        started,
        'The user dismissed the question without answering.',
        'Do not re-ask immediately. Continue only if a safe default exists; otherwise explain what is blocked. An unanswered question is never permission to guess on a destructive action.'
      );
    }

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'timeout':
          return withStatus(
            base,
            'timeout',
            'elicitation',
            started,
            `No answer after ${timeoutMs}ms; the question timed out.`,
            'Do not wait again for the same question. Either ask it in chat instead, or proceed with a documented assumption.'
          );
        case 'aborted':
          return withStatus(
            base,
            'cancelled',
            'elicitation',
            started,
            'The question was cancelled before it was answered (the tool call was aborted).',
            'Stop and wait for new instructions from the user.'
          );
        case 'invalid_response':
          return withStatus(
            base,
            'invalid_response',
            'elicitation',
            started,
            `The client replied with a payload that does not match the requested schema: ${outcome.detail}`,
            'Re-ask with a simpler question, or proceed with a documented assumption.'
          );
        case 'no_capability':
        case 'transport_error':
          failure = outcome.detail;
          break;
      }
    }
  }

  // ---- 2. Fallback policy -------------------------------------------------
  if (config.fallback === 'off') {
    const unsupported = !base.client_elicitation;
    return withStatus(
      base,
      unsupported ? 'unsupported' : 'error',
      'none',
      started,
      unsupported
        ? 'The connected client does not support MCP form elicitation and HIM_FALLBACK=off, so the user cannot be asked.'
        : `Elicitation failed and HIM_FALLBACK=off: ${failure ?? 'unknown error'}`,
      'Do not block. Make the most reasonable choice yourself, state the assumption explicitly in your reply, and continue.',
      true
    );
  }

  if (config.fallback === 'http') {
    const form = await serveForm(question, config.multiSelectMode, {
      timeoutMs,
      host: config.httpHost,
      port: config.httpPort,
      openBrowser: config.httpOpenBrowser,
      signal: extra.signal
    });
    base.form_url = form.url === '' ? null : form.url;

    if (form.reason === 'answered') {
      const interpreted = interpretContent(question, form.values, config.multiSelectMode);
      if (interpreted.ok) {
        return withAnswer(base, question, interpreted.answer, 'http_form', started);
      }
      return withStatus(
        base,
        'invalid_response',
        'http_form',
        started,
        `The form was submitted, but the values could not be validated: ${interpreted.detail}`,
        'Re-ask with a simpler question, or proceed with a documented assumption.'
      );
    }
    if (form.reason === 'cancelled') {
      return withStatus(
        base,
        'cancelled',
        'http_form',
        started,
        'The form was cancelled without submitting an answer.',
        'Do not re-ask immediately. Continue only if a safe default exists; otherwise report what is blocked.'
      );
    }
    if (form.reason === 'timeout') {
      return withStatus(
        base,
        'timeout',
        'http_form',
        started,
        `The form at ${form.url} was not submitted within ${timeoutMs}ms.`,
        'Ask the question in chat instead, or proceed with a documented assumption.'
      );
    }
    return withStatus(
      base,
      'error',
      'none',
      started,
      `Could not start the loopback fallback form: ${form.detail ?? 'unknown error'}`,
      'Ask the question in chat instead, or proceed with a documented assumption.',
      true
    );
  }

  // ---- 3. `return` fallback: hand the question to the agent ---------------
  const prefix = base.client_elicitation
    ? `MCP elicitation failed (${failure ?? 'unknown error'}), so this question was never shown to the user.`
    : 'The connected client does not support MCP form elicitation, so this question was never shown to the user.';
  return unanswerable(base, question, started, prefix);
}

function renderResultText(result: AskResult): string {
  const lines = [`${result.tool}: ${result.status} (via ${result.via}, ${result.elapsed_ms}ms)`];
  lines.push(result.message);
  if (result.status === 'answered') {
    lines.push(`answer: ${result.answer ?? ''}`);
    if (result.free_text) lines.push(`free_text: ${result.free_text}`);
    if (result.selected.length > 0) lines.push(`selected: ${JSON.stringify(result.selected)}`);
    if (result.confirmed !== null) lines.push(`confirmed: ${String(result.confirmed)}`);
  }
  if (result.form_url) lines.push(`form_url: ${result.form_url}`);
  lines.push(`next_step: ${result.next_step}`);
  return lines.join('\n');
}

function toToolResult(outcome: AskOutcome): CallToolResult {
  const payload: CallToolResult = {
    content: [{ type: 'text', text: renderResultText(outcome.result) }],
    structuredContent: outcome.result as unknown as Record<string, unknown>
  };
  return outcome.isError ? { ...payload, isError: true } : payload;
}

/** Argument problems are reported as an error result rather than a throw. */
function argumentError(tool: string, question: string, detail: string, config: ServerConfig): AskOutcome {
  const base = emptyResult(tool, question, config.fallback);
  return {
    result: {
      ...base,
      status: 'error',
      message: `Invalid arguments: ${detail}`,
      next_step: 'Fix the tool arguments and call again.'
    },
    isError: true
  };
}

function duplicateLabel(options: { label: string }[]): boolean {
  const labels = options.map(option => option.label);
  return new Set(labels).size !== labels.length;
}

/** Registers the four question tools plus the diagnostics tool. */
export function registerTools(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    'ask_choice',
    {
      title: 'Ask the user to pick one option',
      description: [
        'Ask the user to choose exactly one of 2-25 options and wait for the answer.',
        'Use this when a decision has a small set of genuinely viable alternatives and the choice changes what you build — for example an architecture, a library, a naming scheme, or a file layout.',
        'Prefer this over ask_confirm whenever the real answer is a choice rather than yes/no, and over ask_text whenever the reasonable answers can be enumerated.',
        'The user may additionally leave free-text notes when allow_free_text is true.',
        'Returns the selected option label in `answer`/`selected`.'
      ].join(' '),
      inputSchema: askChoiceInputSchema,
      outputSchema: askResultShape,
      annotations: QUESTION_ANNOTATIONS
    },
    async (input, extra) => {
      const question: FormQuestion = {
        kind: 'choice',
        question: input.question,
        options: input.options,
        allowFreeText: input.allow_free_text ?? false,
        ...(input.default !== undefined ? { defaultValue: input.default } : {})
      };
      if (duplicateLabel(input.options)) {
        return toToolResult(argumentError('ask_choice', input.question, '`options` contains duplicate labels; labels must be unique.', config));
      }
      if (input.default !== undefined && !input.options.some(option => option.label === input.default)) {
        return toToolResult(
          argumentError('ask_choice', input.question, `\`default\` ("${input.default}") must exactly match one of the option labels.`, config)
        );
      }
      const outcome = await runQuestion('ask_choice', question, input.timeout_ms ?? config.timeoutMs, {
        server,
        config,
        extra
      });
      return toToolResult(outcome);
    }
  );

  server.registerTool(
    'ask_confirm',
    {
      title: 'Ask the user a yes/no question',
      description: [
        'Ask the user a single yes/no question and wait for the answer.',
        'Use this before destructive or irreversible actions (deleting, overwriting, migrating, force-pushing, publishing), and for any binary decision the user should own.',
        'State the exact target and the consequence in `question`, not just "are you sure?".',
        'Returns a boolean in `confirmed` (and "yes"/"no" in `answer`).'
      ].join(' '),
      inputSchema: askConfirmInputSchema,
      outputSchema: askResultShape,
      annotations: QUESTION_ANNOTATIONS
    },
    async (input, extra) => {
      const question: FormQuestion = {
        kind: 'confirm',
        question: input.question,
        ...(input.default !== undefined ? { defaultValue: input.default } : {})
      };
      const outcome = await runQuestion('ask_confirm', question, input.timeout_ms ?? config.timeoutMs, {
        server,
        config,
        extra
      });
      return toToolResult(outcome);
    }
  );

  server.registerTool(
    'ask_text',
    {
      title: 'Ask the user for free-form text',
      description: [
        'Ask the user an open-ended question and wait for a typed answer.',
        'Use this only when the answer cannot be enumerated — a URL, a credential-free identifier, a naming preference, or extra context you cannot infer.',
        'If a handful of concrete answers would cover most cases, use ask_choice instead so the user can answer with one keystroke.',
        'Returns the typed string in `answer`.'
      ].join(' '),
      inputSchema: askTextInputSchema,
      outputSchema: askResultShape,
      annotations: QUESTION_ANNOTATIONS
    },
    async (input, extra) => {
      const question: FormQuestion = {
        kind: 'text',
        question: input.question,
        ...(input.placeholder !== undefined ? { placeholder: input.placeholder } : {}),
        ...(input.default !== undefined ? { defaultValue: input.default } : {})
      };
      const outcome = await runQuestion('ask_text', question, input.timeout_ms ?? config.timeoutMs, {
        server,
        config,
        extra
      });
      return toToolResult(outcome);
    }
  );

  server.registerTool(
    'ask_multi_select',
    {
      title: 'Ask the user to select several options',
      description: [
        'Ask the user to select one or more options from a list and wait for the answer.',
        'Use this when the user should pick a subset — which platforms to target, which checks to enable, which modules to include.',
        'Set min/max when the count genuinely matters; leave them out otherwise.',
        'Returns the selected labels in `selected` and comma-joined in `answer`.'
      ].join(' '),
      inputSchema: askMultiSelectInputSchema,
      outputSchema: askResultShape,
      annotations: QUESTION_ANNOTATIONS
    },
    async (input, extra) => {
      const question: FormQuestion = {
        kind: 'multi_select',
        question: input.question,
        options: input.options,
        ...(input.min !== undefined ? { min: input.min } : {}),
        ...(input.max !== undefined ? { max: input.max } : {})
      };
      if (duplicateLabel(input.options)) {
        return toToolResult(
          argumentError('ask_multi_select', input.question, '`options` contains duplicate labels; labels must be unique.', config)
        );
      }
      const min = input.min ?? 1;
      const max = input.max ?? input.options.length;
      if (min > max) {
        return toToolResult(argumentError('ask_multi_select', input.question, `\`min\` (${min}) must not exceed \`max\` (${max}).`, config));
      }
      if (max > input.options.length) {
        return toToolResult(
          argumentError(
            'ask_multi_select',
            input.question,
            `\`max\` (${max}) cannot exceed the number of options (${input.options.length}).`,
            config
          )
        );
      }
      if (min > input.options.length) {
        return toToolResult(
          argumentError(
            'ask_multi_select',
            input.question,
            `\`min\` (${min}) cannot exceed the number of options (${input.options.length}).`,
            config
          )
        );
      }
      const outcome = await runQuestion('ask_multi_select', question, input.timeout_ms ?? config.timeoutMs, {
        server,
        config,
        extra
      });
      return toToolResult(outcome);
    }
  );

  server.registerTool(
    'human_input_status',
    {
      title: 'Report human-input capability status',
      description: [
        'Diagnostic: report whether the connected client supports MCP form elicitation, which fallback mode is configured, and how long questions may wait.',
        'Call this once when the user asks why a question did not appear, or to verify that this MCP server is actually connected.',
        'This tool never asks the user anything and never blocks.'
      ].join(' '),
      inputSchema: statusInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async input => {
      const capabilities = server.server.getClientCapabilities();
      const report: Record<string, unknown> = {
        server: SERVER_NAME,
        version: SERVER_VERSION,
        client_supports_form_elicitation: Boolean(capabilities?.elicitation?.form),
        client_supports_url_elicitation: Boolean(capabilities?.elicitation?.url),
        client_version: server.server.getClientVersion() ?? null,
        fallback_mode: config.fallback,
        timeout_ms: config.timeoutMs,
        multi_select_mode: config.multiSelectMode,
        auto_reject_threshold_ms: config.autoRejectThresholdMs,
        tools: ['ask_choice', 'ask_confirm', 'ask_text', 'ask_multi_select', 'human_input_status']
      };
      if (input.verbose) {
        report['client_capabilities'] = capabilities ?? null;
        report['effective_config'] = config;
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }]
      };
    }
  );
}
