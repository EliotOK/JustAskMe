/**
 * Loopback HTTP fallback for clients without MCP form elicitation.
 *
 * Why HTTP and not a terminal prompt: an MCP stdio server's stdin IS the
 * JSON-RPC channel. Reading it to ask a question would corrupt the protocol,
 * and writing a prompt to stdout would do the same. A short-lived HTTP server
 * bound to the loopback interface is the only fallback that leaves the MCP
 * message flow completely untouched.
 *
 * Safety properties:
 *   - binds to `127.0.0.1` (never `0.0.0.0`), so it is not reachable off-host;
 *   - requires a 128-bit random token, compared in constant time;
 *   - serves exactly one question and shuts itself down on answer / timeout /
 *     cancellation, so there is no long-running GUI to manage;
 *   - no external assets, no CDN, no telemetry — works fully offline.
 */
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { log } from './logger.js';
import type { ChoiceOption, FormQuestion } from './outcome.js';

/** Raw field values exactly as an elicitation `content` object would carry them. */
export type HttpFormValues = Record<string, string | string[] | boolean>;

export interface HttpFormOutcome {
  reason: 'answered' | 'cancelled' | 'timeout' | 'error';
  values: HttpFormValues;
  url: string;
  detail?: string;
}

export interface HttpFormOptions {
  timeoutMs: number;
  host: string;
  port: number;
  openBrowser: boolean;
  signal?: AbortSignal | undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function optionRows(options: ChoiceOption[], inputType: 'radio' | 'checkbox', name: string): string {
  return options
    .map((option, index) => {
      const id = `${name}_${index}`;
      const description = option.description
        ? `<span class="desc">${escapeHtml(option.description)}</span>`
        : '';
      return `<label class="opt" for="${id}">
  <input type="${inputType}" id="${id}" name="${escapeHtml(name)}" value="${escapeHtml(option.label)}">
  <span class="label">${escapeHtml(option.label)}</span>${description}
</label>`;
    })
    .join('\n');
}

function buildBody(question: FormQuestion, multiSelectMode: 'array' | 'text'): string {
  switch (question.kind) {
    case 'choice': {
      const freeText = question.allowFreeText
        ? `<label class="block">Additional notes (optional)
  <textarea name="free_text" rows="3" placeholder="Optional free-text answer"></textarea>
</label>`
        : '';
      return `<fieldset>
  <legend>Choose one</legend>
  ${optionRows(question.options, 'radio', 'choice')}
</fieldset>
${freeText}`;
    }
    case 'confirm': {
      const yesChecked = question.defaultValue === true ? ' checked' : '';
      const noChecked = question.defaultValue === false ? ' checked' : '';
      return `<fieldset>
  <legend>Answer</legend>
  <label class="opt"><input type="radio" name="confirm" value="true"${yesChecked}> <span class="label">Yes</span></label>
  <label class="opt"><input type="radio" name="confirm" value="false"${noChecked}> <span class="label">No</span></label>
</fieldset>`;
    }
    case 'text': {
      const placeholder = question.placeholder ? escapeHtml(question.placeholder) : '';
      const value = question.defaultValue !== undefined ? escapeHtml(question.defaultValue) : '';
      return `<label class="block">Your answer
  <textarea name="text" rows="5" placeholder="${placeholder}">${value}</textarea>
</label>`;
    }
    case 'multi_select': {
      if (multiSelectMode === 'text') {
        const allowed = question.options.map(option => option.label).join(', ');
        return `<label class="block">Selections (comma-separated)
  <input type="text" name="choices_text" placeholder="${escapeHtml(allowed)}">
</label>
<p class="hint">Allowed: ${escapeHtml(allowed)}</p>`;
      }
      return `<fieldset>
  <legend>Select one or more</legend>
  ${optionRows(question.options, 'checkbox', 'choices')}
</fieldset>`;
    }
  }
}

function renderPage(question: FormQuestion, multiSelectMode: 'array' | 'text', token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Codex needs your input</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif; margin: 0; padding: 32px 16px; background: #f6f7f9; color: #16181d; }
  main { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #e3e5ea; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .kicker { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; margin: 0 0 8px; }
  h1 { font-size: 18px; line-height: 1.4; white-space: pre-wrap; margin: 0 0 20px; }
  fieldset { border: 1px solid #e3e5ea; border-radius: 10px; padding: 12px 14px; margin: 0 0 16px; }
  legend { padding: 0 6px; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: .06em; }
  .opt { display: flex; gap: 10px; align-items: baseline; padding: 7px 0; cursor: pointer; }
  .opt .label { font-weight: 600; }
  .desc { color: #4b5563; font-size: 13px; }
  .block { display: block; font-size: 13px; color: #374151; margin-bottom: 16px; }
  textarea, input[type=text] { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; padding: 9px 10px; font: inherit; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; color: inherit; }
  .hint { font-size: 13px; color: #6b7280; margin: -8px 0 16px; }
  .actions { display: flex; gap: 10px; margin-top: 4px; }
  button { font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; }
  button.primary { background: #16181d; color: #fff; }
  button.ghost { background: transparent; border-color: #d1d5db; color: inherit; }
  .err { color: #b91c1c; font-size: 13px; min-height: 18px; margin-top: 10px; }
  @media (prefers-color-scheme: dark) {
    body { background: #101216; color: #e8eaee; }
    main { background: #171a20; border-color: #262a33; }
    fieldset { border-color: #262a33; }
    textarea, input[type=text] { background: #101216; border-color: #333844; }
    button.primary { background: #e8eaee; color: #101216; }
    button.ghost { border-color: #333844; }
    .desc, .hint, .block { color: #9aa2b1; }
  }
</style>
</head>
<body>
<main>
  <p class="kicker">Codex is waiting for your answer</p>
  <h1>${escapeHtml(question.question)}</h1>
  <form id="q">
    ${buildBody(question, multiSelectMode)}
    <div class="actions">
      <button type="submit" class="primary">Submit</button>
      <button type="button" class="ghost" id="cancel">Cancel</button>
    </div>
    <p class="err" id="err"></p>
  </form>
</main>
<script>
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var form = document.getElementById('q');
  var err = document.getElementById('err');

  function collect() {
    var values = {};
    var data = new FormData(form);
    data.forEach(function (value, key) {
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        if (!Array.isArray(values[key])) values[key] = [values[key]];
        values[key].push(value);
      } else {
        values[key] = value;
      }
    });
    return values;
  }

  function send(payload) {
    return fetch('/answer?token=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    err.textContent = '';
    send({ cancelled: false, values: collect() })
      .then(function () {
        document.body.innerHTML = '<main><p class="kicker">Submitted</p><h1>Thanks — you can close this tab.</h1></main>';
      })
      .catch(function (error) { err.textContent = 'Submit failed: ' + error.message; });
  });

  document.getElementById('cancel').addEventListener('click', function () {
    send({ cancelled: true, values: {} })
      .then(function () {
        document.body.innerHTML = '<main><p class="kicker">Cancelled</p><h1>No answer was sent. You can close this tab.</h1></main>';
      })
      .catch(function (error) { err.textContent = 'Cancel failed: ' + error.message; });
  });
})();
</script>
</body>
</html>`;
}

function readBody(request: IncomingMessage, limitBytes = 262_144): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** Coerces the raw JSON payload posted by the page into elicitation-style values. */
function normalizeValues(raw: unknown): HttpFormValues {
  const values: HttpFormValues = {};
  if (typeof raw !== 'object' || raw === null) return values;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      values[key] = value;
    } else if (Array.isArray(value)) {
      values[key] = value.map(entry => String(entry));
    }
  }
  if (typeof values['confirm'] === 'string') {
    // `confirm` must reach interpretContent as a real boolean.
    values['confirm'] = values['confirm'] === 'true';
  }
  return values;
}

function openInBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === 'win32') {
    command = 'cmd';
    // The empty argument is the window title; without it `start` eats the URL.
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', error => log.debug('could not open browser:', error));
    child.unref();
  } catch (error) {
    log.debug('could not open browser:', error);
  }
}

/**
 * Serves one question over loopback HTTP and resolves with the raw answer.
 * Always tears the server down before returning.
 */
export async function serveForm(
  question: FormQuestion,
  multiSelectMode: 'array' | 'text',
  options: HttpFormOptions
): Promise<HttpFormOutcome> {
  const token = randomBytes(16).toString('hex');

  let finish: (outcome: HttpFormOutcome) => void = () => undefined;
  const settled = new Promise<HttpFormOutcome>(resolve => {
    finish = resolve;
  });

  let httpServer: Server | undefined;
  let url = '';
  let done = false;

  const complete = (outcome: HttpFormOutcome): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    try {
      httpServer?.closeAllConnections?.();
      httpServer?.close();
    } catch {
      /* ignore */
    }
    finish({ ...outcome, url });
  };

  const onAbort = (): void => complete({ reason: 'cancelled', values: {}, url });

  const timer = setTimeout(() => complete({ reason: 'timeout', values: {}, url }), options.timeoutMs);
  // Node keeps the process alive for this timer; it is cleared in `complete`.

  httpServer = createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      const supplied = requestUrl.searchParams.get('token') ?? '';
      if (!safeEqual(supplied, token)) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Forbidden');
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/') {
        const html = renderPage(question, multiSelectMode, token);
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(html)
        });
        response.end(html);
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/answer') {
        try {
          const body = await readBody(request);
          const parsed = JSON.parse(body) as { cancelled?: unknown; values?: unknown };
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{"ok":true}');
          if (parsed.cancelled === true) {
            complete({ reason: 'cancelled', values: {}, url });
          } else {
            complete({ reason: 'answered', values: normalizeValues(parsed.values), url });
          }
        } catch (error) {
          response.writeHead(400, { 'Content-Type': 'application/json' });
          response.end('{"ok":false}');
          log.debug('bad answer payload:', error);
        }
        return;
      }

      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    })().catch(error => {
      log.debug('http fallback handler error:', error);
      try {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Internal error');
      } catch {
        /* ignore */
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer?.once('error', reject);
      httpServer?.listen(options.port, options.host, () => {
        httpServer?.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    clearTimeout(timer);
    const detail = error instanceof Error ? error.message : String(error);
    log.warn('could not start the loopback form server:', detail);
    return { reason: 'error', values: {}, url: '', detail };
  }

  const address = httpServer?.address() ?? null;
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  url = `http://${options.host}:${port}/?token=${token}`;

  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener('abort', onAbort, { once: true });
  }

  log.warn(`MCP elicitation unavailable — open this URL to answer: ${url}`);
  if (options.openBrowser) openInBrowser(url);

  return settled;
}
