/**
 * Branching a session from an agent reply (COR-1566), against the real host. The final agent
 * message of each completed turn offers Branch from here. Activating it opens a new session that
 * holds the history through that reply, runs on the parent's model, and says where it came from
 * with a link back. A branch the Bureau refuses leaves the person on the parent. The case runs at
 * a phone's width and a desktop's, with axe passing.
 */
import type { Page } from '@playwright/test';

import { CHAT_COPY } from '../../src/app/copy.ts';
import { MODEL_SWITCHER_MODELS } from '../../src/host/seed.ts';
import { expectWaiting, newThreadId, releaseBarrier, runToEnd } from './chat-support.ts';
import { E2E_BASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;

const [, HAIKU] = MODEL_SWITCHER_MODELS;
const ASSISTANT_ROW = '[data-message-role="assistant"]';
const USER_ROW = '[data-message-role="user"]';

const branchAction = (page: Page) => page.getByRole('button', { name: CHAT_COPY.branch.action });
const picker = (page: Page) => page.getByRole('combobox', { name: 'Model' });

/** A session of `model-switcher` switched to its second model, with two turns in it. */
async function seedSession(
  request: Parameters<typeof runToEnd>[0],
  threadId: string,
): Promise<void> {
  await runToEnd(request, 'model-switcher', threadId, 'First question');
  const context = await request.post(`${E2E_BASE_URL}/bureau/jsonrpc`, {
    data: { jsonrpc: '2.0', id: 1, method: 'bureau.contexts.get', params: { contextId: threadId } },
  });
  const detail = (await context.json()) as { result: { configVersion: number } };
  const { configVersion } = detail.result;
  const steered = await request.post(`${E2E_BASE_URL}/bureau/jsonrpc`, {
    data: {
      jsonrpc: '2.0',
      id: 2,
      method: 'bureau.contexts.steer',
      params: {
        contextId: threadId,
        commandId: `steer-${crypto.randomUUID()}`,
        override: HAIKU,
        expectedRevision: configVersion,
      },
    },
  });
  const outcome = (await steered.json()) as { result: { outcome: string } };
  expect(outcome.result.outcome).toBe('accepted');
  await runToEnd(request, 'model-switcher', threadId, 'Second question');
}

for (const viewport of VIEWPORTS) {
  test(`branches from the first reply into a session of its own, with the history and model it had, at ${viewport.width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    const parentId = newThreadId('branch');
    await seedSession(request, parentId);
    await page.goto(`/chat/${parentId}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator(ASSISTANT_ROW)).toHaveCount(2);
    // Each turn ends in a reply that offers a branch.
    await expect(branchAction(page)).toHaveCount(2);
    await expect(page.locator('.weft-chat-header__origin')).toHaveCount(0);

    // Branching from the first reply opens a new session holding the first turn alone.
    await page.locator(ASSISTANT_ROW).first().hover();
    await branchAction(page).first().click();
    await expect(page).toHaveURL(
      (url) => url.pathname.startsWith('/chat/') && url.pathname !== `/chat/${parentId}`,
    );
    const branchId = new URL(page.url()).pathname.slice('/chat/'.length);
    expect(branchId).not.toBe('new');
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator(USER_ROW)).toHaveCount(1);
    await expect(page.locator(USER_ROW)).toContainText('First question');
    await expect(page.locator(ASSISTANT_ROW)).toHaveCount(1);
    // It runs on the model its parent was switched to.
    await expect(picker(page).locator('option:checked')).toHaveText(HAIKU.model);
    // Its header says where it came from, and links back.
    const origin = page.locator('.weft-chat-header__origin');
    await expect(origin).toContainText(CHAT_COPY.branch.branchedFrom);
    await checkA11y(`a branch, at ${viewport.width} pixels`);
    await origin.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/chat/${parentId}$`));
    await expect(page.locator(USER_ROW)).toHaveCount(2);
    await expect(page.locator('.weft-chat-header__origin')).toHaveCount(0);
  });
}

test('stays on the session and says why when the Bureau refuses the branch', async ({
  page,
  request,
  checkA11y,
}) => {
  const parentId = newThreadId('refused');
  await runToEnd(request, 'model-switcher', parentId, 'A question');
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = route.request().postDataJSON() as { id: unknown; method: string };
    if (body.method !== 'bureau.contexts.fork') return route.continue();
    return route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32000,
          message: 'The run ended in error.',
          data: { reason: 'branch-from-errored-run', weftCode: 'Conflict', httpStatus: 409 },
        },
      },
    });
  });
  await page.goto(`/chat/${parentId}`);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');

  await page.locator(ASSISTANT_ROW).first().hover();
  await branchAction(page).click();

  await expect(page.getByText(CHAT_COPY.branch.refused['branch-from-errored-run'])).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/chat/${parentId}$`));
  await checkA11y('a refused branch');
});

test('offers a branch only on the last reply of a run, not on the earlier reply of a run a follow-up joined', async ({
  page,
  request,
}) => {
  // A session with one finished turn, then a run held on the barrier that a follow-up is delivered to.
  const threadId = newThreadId('joined');
  const seeded = runToEnd(request, 'barrier', threadId, 'Seed the session');
  await expectWaiting(request, 1);
  await releaseBarrier(request);
  await seeded;
  await page.goto(`/chat/${threadId}`);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  await page.getByRole('textbox').fill('Start the work');
  await page.getByRole('textbox').press('Enter');
  await expectWaiting(request, 1);
  const delivered = page.waitForResponse(
    (response) =>
      response.url().endsWith('/bureau/jsonrpc') &&
      (response.request().postData() ?? '').includes('"bureau.contexts.input"'),
  );
  await page.getByRole('textbox').fill('Also this');
  await page.getByRole('textbox').press('Enter');
  await delivered;

  // While a run is going, no reply offers a branch, whichever run it belongs to.
  const replies = page.locator('.chat-message-wrapper[data-role="assistant"]');
  const offered = (index: number) =>
    replies.nth(index).getByRole('button', { name: CHAT_COPY.branch.action });
  await expect(replies).toHaveCount(2);
  await expect(offered(0)).toHaveCount(0);
  await expect(offered(1)).toHaveCount(0);

  await releaseBarrier(request);
  await expect(replies).toHaveCount(3);
  await expect(page.getByRole('button', { name: /stop/i })).toHaveCount(0);
  // The run's earlier reply, which the follow-up interrupted, offers nothing; its last reply does.
  await expect(offered(0)).toHaveCount(1);
  await expect(offered(1)).toHaveCount(0);
  await expect(offered(2)).toHaveCount(1);

  // The same after a reload, from the transcript the Bureau holds.
  await page.reload();
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  await expect(replies).toHaveCount(3);
  await expect(offered(0)).toHaveCount(1);
  await expect(offered(1)).toHaveCount(0);
  await expect(offered(2)).toHaveCount(1);
});
