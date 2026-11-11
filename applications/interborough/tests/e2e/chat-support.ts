/**
 * What the chat specs share: sessions seeded through the AG-UI mount (the way a client other than
 * the page would start one), the barrier the specs hold a run on (`barrier-agent.ts`), so no case
 * waits on a clock, and the cleanup that gives a host back its seed (`deleteChats`).
 */
import type { APIRequestContext, Locator, Page } from '@playwright/test';

import { E2E_BARRIER_URL, E2E_BASE_URL } from './e2e-constants.ts';
import { expect } from './fixtures.ts';

const AG_UI = `${E2E_BASE_URL}/bureau/ag-ui`;

/**
 * The open chat's conversation. A chat page also lists the chats beside it, and a row there prints
 * a chat's title and its latest message, so text a spec looks for in the transcript is searched for
 * here and not on the whole page, where it would match the list's copy as well.
 */
export function conversation(page: Page): Locator {
  return page.getByRole('region', { name: 'Conversation' });
}

/** A composer select a spec waits for, by its name, and the words it should show once settled. */
export interface ComposerSelectExpectation {
  readonly name: string | RegExp;
  readonly text?: string | RegExp;
}

/**
 * Opens the composer's Settings control when it has folded Model, Effort and Permissions into one
 * (a composer narrower than 40rem, as at a phone's width, or one whose values do not fit in full
 * beside Send), so the selects are on the page, and waits until each select in `settled` shows,
 * with its words when given. A composer showing them in the row has no such control.
 *
 * The composer decides the fold (`data-controls-folded`, set by `@lostgradient/chat`) from its
 * selects' values, which arrive with the chat's settings and the agent's models, so a row can fold
 * a moment after it is first drawn. The look is taken again until the selects show the words the
 * spec expects; by then every value that decides the fold has arrived.
 */
export async function revealSettings(
  page: Page,
  settled: readonly ComposerSelectExpectation[] = [{ name: /Permissions/ }],
): Promise<void> {
  const composer = page.locator('.chat-input').first();
  await expect(composer).toBeVisible();
  const settings = page.getByTestId('composer-settings');
  // An open chat on a model reads how full its context window is on its own, and the reading takes
  // room beside Send, so the fold is settled only once it has arrived (or said it is unavailable).
  const meter = page.locator('.weft-context-meter, .weft-context-meter__unavailable');
  const openChatOnModel = !new URL(page.url()).pathname.endsWith('/chats/new');
  await expect(async () => {
    const folded = (await composer.getAttribute('data-controls-folded')) !== null;
    if (folded && (await settings.getAttribute('aria-expanded')) !== 'true') await settings.click();
    // With Settings open, a chat on a model has its Model select on the page, folded or not.
    const onModel = (await page.getByRole('combobox', { name: 'Model' }).count()) > 0;
    if (openChatOnModel && onModel) {
      // load-proof: a miss only looks again once the reading has arrived, so a slow host adds attempts, never a failure.
      await expect(meter.first()).toBeVisible({ timeout: 1_000 });
    }
    for (const { name, text } of settled) {
      const select = page.getByRole('combobox', { name });
      // load-proof: a miss only looks again, opening Settings if the row folded meanwhile, so a slow host adds attempts, never a failure.
      await expect(select).toBeVisible({ timeout: 1_000 });
      if (text !== undefined) {
        // load-proof: a miss only looks again once the chat's settings have arrived, so a slow host adds attempts, never a failure.
        await expect(select).toContainText(text, { timeout: 1_000 });
      }
    }
  }).toPass();
}

/**
 * Expects the composer's selects named by `names` on the page: in the row, or, when the composer
 * folded them into Settings because their values in full do not fit, in the Settings popover, which
 * this opens to look and closes again. Focus goes back where it was, so typing carries on in the box.
 */
export async function expectComposerSelects(
  page: Page,
  names: readonly (string | RegExp)[],
): Promise<void> {
  const focused = await page.evaluateHandle(() => document.activeElement);
  await revealSettings(
    page,
    names.map((name) => ({ name })),
  );
  await hideModelPicker(page);
  await focused.evaluate((element) => {
    if (element instanceof HTMLElement) element.focus();
  });
  await focused.dispose();
}

/** A thread identifier no other case uses. */
export function newThreadId(label: string): string {
  return `e2e-${label}-${crypto.randomUUID()}`;
}

function runInput(threadId: string, message: string, extra: Record<string, unknown> = {}) {
  return {
    threadId,
    runId: `run-${crypto.randomUUID()}`,
    messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: message }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    ...extra,
  };
}

/**
 * Starts a run and reads its stream to the end; the session exists afterwards. `origin` is the host
 * the run starts on: the main host unless a spec names another.
 */
export async function runToEnd(
  request: APIRequestContext,
  agent: string,
  threadId: string,
  message: string,
  extra: Record<string, unknown> = {},
  origin: string = E2E_BASE_URL,
): Promise<string> {
  const response = await request.post(`${origin}/bureau/ag-ui/agents/${agent}/run`, {
    headers: { accept: 'text/event-stream' },
    data: runInput(threadId, message, extra),
  });
  expect(response.status()).toBe(200);
  return response.text();
}

/**
 * Deletes the chats a spec started, through the Bureau's management plane, so the host holds only
 * what it held before the spec. A spec on a host that a later spec reads as fresh (the second
 * host's `/chats` is empty until a case starts a chat, and the Bureau lists every chat, approval and
 * notification in it) deletes what it started in an `afterAll`, whether the run passed or not. A
 * chat that was never started is not an error, so a case that failed before it started one cleans
 * up like one that did not. Anything else the Bureau refuses fails the hook loudly.
 */
export async function deleteChats(
  threadIds: readonly string[],
  origin: string = E2E_BASE_URL,
): Promise<void> {
  for (const contextId of threadIds) {
    const response = await fetch(`${origin}/bureau/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `delete-${contextId}`,
        method: 'bureau.contexts.delete',
        params: { contextId },
      }),
    });
    expect(response.status, `deleting ${contextId}`).toBe(200);
    const body = (await response.json()) as { error?: { message?: string } };
    const message = body.error?.message;
    if (message !== undefined && !message.startsWith('No context with id')) {
      throw new Error(`The Bureau did not delete ${contextId}: ${message}`);
    }
  }
}

/** A run left going: its stream is open and the caller reads nothing, so the run waits where it is. */
export async function startRun(
  agent: string,
  threadId: string,
  message: string,
): Promise<AbortController> {
  const controller = new AbortController();
  const response = await fetch(`${AG_UI}/agents/${agent}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(runInput(threadId, message)),
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  return controller;
}

/** The interrupt a settled stream ended on. */
export function interruptIdOf(stream: string): string {
  const match = /"interrupts":\[\{"id":"([^"]+)"/.exec(stream);
  if (match?.[1] === undefined) throw new Error('The stream ended on no interrupt.');
  return match[1];
}

/** Resolves the approval a tool-runner session is waiting on, as another client would. */
export async function approveThroughMount(
  request: APIRequestContext,
  threadId: string,
  stream: string,
): Promise<string> {
  return runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001', {
    messages: [],
    resume: [
      { interruptId: interruptIdOf(stream), status: 'resolved', payload: { decision: 'approve' } },
    ],
  });
}

export async function waitingOnBarrier(request: APIRequestContext): Promise<number> {
  const response = await request.get(`${E2E_BARRIER_URL}/waiting`);
  return ((await response.json()) as { waiting: number }).waiting;
}

/** Waits until `count` runs are held at the barrier. */
export async function expectWaiting(request: APIRequestContext, count: number): Promise<void> {
  await expect.poll(() => waitingOnBarrier(request)).toBe(count);
}

export async function releaseBarrier(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${E2E_BARRIER_URL}/release`);
  expect(response.ok()).toBe(true);
}

/** The model select of a chat's composer. */
export const modelPicker = (page: Page) => page.getByRole('combobox', { name: 'Model' });

/**
 * Shows the model picker. A composer too narrow for its controls side by side folds them into one
 * Settings button (the phone, and a pane beside the chat list), and the picker is then in the
 * popover that button opens. `model` is the model the picker should show once the chat's settings
 * have arrived, which is also when the composer has settled whether it folds.
 */
export async function showModelPicker(page: Page, model?: string | RegExp): Promise<void> {
  await revealSettings(page, [{ name: 'Model', ...(model === undefined ? {} : { text: model }) }]);
}

/** Closes the popover that holds a folded composer's controls, when it is open, so the page can be used again. */
export async function hideModelPicker(page: Page): Promise<void> {
  const settings = page.getByTestId('composer-settings');
  if ((await settings.isVisible()) && (await settings.getAttribute('aria-expanded')) === 'true') {
    await page.keyboard.press('Escape');
    await expect(settings).toHaveAttribute('aria-expanded', 'false');
    // On a phone the popover is a sheet, which is gone from the page once it has closed.
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  }
}
