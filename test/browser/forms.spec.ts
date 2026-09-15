import { test, expect } from '@playwright/test';
import { serveForm } from '../../src/http-form.js';
import type { FormQuestion } from '../../src/outcome.js';

async function start(question: FormQuestion) {
  let url = '';
  const original = process.stderr.write.bind(process.stderr);
  const abort = new AbortController();
  process.stderr.write = ((chunk: string | Uint8Array) => {
    const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/);
    if (match) url = match[0];
    return original(chunk);
  }) as typeof process.stderr.write;
  const pending = serveForm(question, 'array', {
    host: '127.0.0.1', port: 0, timeoutMs: 15_000, openBrowser: false, signal: abort.signal
  });
  try {
    await expect.poll(() => url).not.toBe('');
  } finally { process.stderr.write = original; }
  return { url, pending, close: async () => { abort.abort(); await pending; } };
}

const multi = (min: number, max: number): FormQuestion => ({
  kind: 'multi_select', question: 'Which platforms?', options: [{ label: 'Windows' }, { label: 'Linux' }], min, max
});

test('one of two checkboxes submits successfully', async ({ page }) => {
  const form = await start(multi(1, 1));
  try {
    await page.goto(form.url);
    await page.getByLabel('Windows', { exact: true }).check();
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Thanks — you can close this tab.')).toBeVisible();
    expect((await form.pending).values.choices).toBe('Windows');
  } finally { await form.close(); }
});

test('too many selections preserve the page and can be corrected', async ({ page }) => {
  const form = await start(multi(1, 1));
  try {
    await page.goto(form.url);
    await page.getByLabel('Windows', { exact: true }).check();
    await page.getByLabel('Linux', { exact: true }).check();
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.locator('#err')).toContainText('between 1 and 1');
    await expect(page.getByLabel('Windows', { exact: true })).toBeChecked();
    await page.getByLabel('Linux', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Thanks — you can close this tab.')).toBeVisible();
  } finally { await form.close(); }
});

test('zero selections submit when min is zero', async ({ page }) => {
  const form = await start(multi(0, 1));
  try {
    await page.goto(form.url);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Thanks — you can close this tab.')).toBeVisible();
    expect((await form.pending).reason).toBe('answered');
  } finally { await form.close(); }
});

test('empty text receives a server error and can be corrected into a free-text reply', async ({ page }) => {
  const form = await start({ kind: 'choice', question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }], allowFreeText: true });
  try {
    await page.goto(form.url);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.locator('#err')).toContainText('non-empty');
    await page.locator('textarea').fill('Explain the differences first');
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('Thanks — you can close this tab.')).toBeVisible();
    expect((await form.pending).values.free_text).toBe('Explain the differences first');
  } finally { await form.close(); }
});
