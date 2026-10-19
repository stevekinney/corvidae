/**
 * `/reviews` against the real host: the Bureau's tool approvals and questions, listed with the
 * engine's reviews, decided and answered there. Approving `tool-runner`'s review runs its tool; chat
 * and the inbox agree about an approval whichever one decides it; and a question is answered with
 * one text field. Sessions are started through the AG-UI mount, the way a client other than the page
 * would.
 */
import type { Page } from '@playwright/test';

import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { bureauCall, taskOfSession, threadMessages } from './task-support.ts';

const WIDTHS = [375, 1280] as const;

/** The Bureau's row for a session's review: the one list item that links to that session's chat. */
const rowOfSession = (page: Page, threadId: string) =>
  page.locator('.weft-reviews-inbox__list > li').filter({
    has: page.locator(`a[href="/chat/${threadId}"]`),
  });

/** Whether a tool result in a conversation carries `refundedCents`, which only a refund that ran does. */
function refundRan(messages: unknown[]): boolean {
  return JSON.stringify(messages).includes('refundedCents');
}

test.describe('a tool approval', () => {
  test('approved from the inbox runs the tool, and its row goes', async ({
    page,
    request,
    checkA11y,
  }) => {
    const threadId = newThreadId('reviews-approve');
    await runToEnd(request, 'tool-runner', threadId, 'Refund order-1001');
    expect(refundRan(await threadMessages(request, threadId))).toBe(false);

    await page.goto('/reviews');
    const row = rowOfSession(page, threadId);
    await expect(row).toBeVisible();
    await expect(row).toContainText('issue-refund');
    await row.getByRole('button').click();
    await expect(page.getByRole('heading', { level: 2, name: 'Tool approval' })).toBeVisible();
    await expect(page.getByText('order-1001').first()).toBeVisible();
    await checkA11y('a tool approval in the inbox');
    await page.getByRole('button', { name: 'Approve' }).click();

    await expect(row).toHaveCount(0);
    // The row going is not the evidence: the tool ran, and its result is in the conversation.
    await expect.poll(async () => refundRan(await threadMessages(request, threadId))).toBe(true);
  });

  test('rejected from the inbox needs a reason, and the tool never runs', async ({
    page,
    request,
  }) => {
    const threadId = newThreadId('reviews-reject');
    await runToEnd(request, 'tool-runner', threadId, 'Refund order-1001');

    await page.goto('/reviews');
    const row = rowOfSession(page, threadId);
    await row.getByRole('button').click();
    const reject = page.getByRole('button', { name: 'Reject' });
    await expect(reject).toBeDisabled();
    await page.getByLabel(/Reason/).fill('Wrong customer.');
    await reject.click();

    await expect(row).toHaveCount(0);
    expect(refundRan(await threadMessages(request, threadId))).toBe(false);
  });

  test('decided in the chat is gone from the inbox once the run goes on', async ({
    page,
    request,
  }) => {
    const threadId = newThreadId('reviews-chat-first');
    await runToEnd(request, 'tool-runner', threadId, 'Refund order-1001');

    await page.goto('/reviews');
    await expect(rowOfSession(page, threadId)).toBeVisible();

    await page.goto(`/chat/${threadId}`);
    const alert = page.getByRole('alert').filter({ hasText: 'Needs your approval' });
    await alert.getByRole('button', { name: 'Approve' }).click();
    // The run goes on after the approval and reports what it did.
    await expect(page.getByText('Order order-1001 was refunded.')).toBeVisible();

    await page.goto('/reviews');
    await expect(page.getByRole('heading', { level: 1, name: 'Reviews' })).toBeVisible();
    await expect(rowOfSession(page, threadId)).toHaveCount(0);
    const listed = (await bureauCall(request, 'bureau.reviews.list', {})) as {
      reviews: Array<{ sessionId?: string }>;
    };
    expect(listed.reviews.filter((review) => review.sessionId === threadId)).toEqual([]);
  });

  test('decided in the inbox shows its result when the chat is opened, and not the approval', async ({
    page,
    request,
  }) => {
    const threadId = newThreadId('reviews-inbox-first');
    await runToEnd(request, 'tool-runner', threadId, 'Refund order-1001');

    await page.goto('/reviews');
    const row = rowOfSession(page, threadId);
    await row.getByRole('button').click();
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(row).toHaveCount(0);

    // A chat opened afterwards reads the conversation the decision wrote into.
    await page.goto(`/chat/${threadId}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Refund order-1001');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Needs your approval' }),
    ).toHaveCount(0);
    await expect(page.getByText('issue-refund').first()).toBeVisible();
  });
});

test.describe('a question a run asks', () => {
  test('is answered with one text field in the inbox, and the run goes on', async ({
    page,
    request,
    checkA11y,
  }) => {
    const threadId = newThreadId('reviews-question');
    await runToEnd(request, 'request-human-input', threadId, 'Release it');

    await page.goto('/reviews');
    const row = rowOfSession(page, threadId);
    await expect(row).toContainText('Which environment should the release go to?');
    await row.getByRole('button').click();
    await checkA11y('a question in the inbox');
    await page.getByLabel('Your answer').fill('staging');
    await page.getByRole('button', { name: 'Send answer' }).click();

    await expect(row).toHaveCount(0);
    const task = await taskOfSession(request, threadId);
    await expect.poll(async () => ((await bureauCall(request, 'bureau.tasks.get', { taskId: task.id })) as { status: string }).status).toBe('completed');
  });
});

test.describe('the count in the navigation', () => {
  test('follows what is waiting, with no reload', async ({ page, request }) => {
    await page.goto('/reviews');
    const link = page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: /^Reviews/ });
    const before = Number(((await link.textContent()) ?? '').replace(/\D/g, '') || '0');

    await runToEnd(request, 'tool-runner', newThreadId('reviews-count'), 'Refund order-1001');

    // The page asks again every five seconds, so a new approval shows without a reload.
    await expect(link).toContainText(String(before + 1), { timeout: 15_000 });
  });
});

for (const width of WIDTHS) {
  test(`the inbox fits at ${width} pixels, and passes axe`, async ({ page, request, checkA11y }) => {
    await page.setViewportSize({ width, height: 900 });
    await runToEnd(request, 'tool-runner', newThreadId('reviews-width'), 'Refund order-1001');

    await page.goto('/reviews');

    await expect(page.locator('.weft-reviews-inbox__list > li').first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await checkA11y(`the inbox at ${width}px`);
  });
}
