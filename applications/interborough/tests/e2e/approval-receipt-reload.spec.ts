/**
 * COR-2292 D6 (COR-2439 AC1): a tool approval's receipt survives a reload, once. One refund is
 * approved through Reviews and another in its chat; reloading each chat shows exactly one receipt
 * for its decision: the Reviews one is a card under its rail row that says where, with Reviews a
 * link to the review, and the chat one is its rail row's line, which names no place. Runs against
 * the real host; sessions are started through the AG-UI mount.
 */
import type { Page } from '@playwright/test';

import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { waitingReviewOf, type WaitingReview } from './task-support.ts';

test.use({ viewport: { width: 1600, height: 900 } });

/** The address of the inbox with `review` open. */
const inboxAt = (review: WaitingReview): string =>
  `/reviews?review=${encodeURIComponent(`bureau:${review.id}`)}`;

/** The decided receipts of a chat: the decision surface's one line (board row A4), one per receipt. */
const receiptsOf = (page: Page) =>
  page.locator('.cinder-approval-card--decision .cinder-approval-card__receipt-line');

test('a decision made in Reviews and one made in the chat each read as one receipt after a reload', async ({
  page,
  request,
}) => {
  // Decided through Reviews.
  const viaReviews = newThreadId('receipt-reload-reviews');
  await runToEnd(request, 'demo:tool-runner', viaReviews, 'Refund order-1001');
  const review = await waitingReviewOf(request, viaReviews);
  await page.goto(inboxAt(review));
  await page.locator('.ib-review-pane').getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator(`[data-review-row="bureau:${review.id}"]`)).toHaveCount(0);

  // Decided in its chat.
  const viaChat = newThreadId('receipt-reload-chat');
  await runToEnd(request, 'demo:tool-runner', viaChat, 'Refund order-1002');
  await page.goto(`/chats/${viaChat}`);
  await page.locator('[data-approval-decision]').getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('[data-approval-decision]')).toHaveCount(0);

  // After a reload, the Reviews decision is one receipt that says where, and links there.
  await page.goto(`/chats/${viaReviews}`);
  await page.reload();
  await expect(receiptsOf(page)).toHaveCount(1);
  await expect(receiptsOf(page).locator('.cinder-approval-card__receipt-status')).toHaveText(
    'Approved',
  );
  await expect(receiptsOf(page).locator('.cinder-approval-card__receipt-by')).toHaveText(
    /^by .+ in Reviews$/,
  );
  await expect(receiptsOf(page).locator('.cinder-approval-card__receipt-time')).toHaveText(
    /^\d{1,2}:\d{2} [AP]M$/,
  );
  await expect(
    page.locator('.cinder-approval-card--decision').getByRole('link', { name: 'Reviews' }),
  ).toHaveAttribute(
    'href',
    new RegExp(`/reviews\\?tab=done&review=${encodeURIComponent(`bureau:${review.id}`)}`),
  );
  await expect(page.locator('[data-approval-decision]')).toHaveCount(0);

  // The rail row above the receipt leaves the decision to it, so the turn says it once (A4).
  const approvedRow = page.locator(
    '.cinder-tool-call-rail__item[data-cinder-status="approved"] > .cinder-tool-call-rail__row',
  );
  await expect(approvedRow).toHaveCount(1);
  await expect(approvedRow).not.toContainText('Approved by');
  const decidedRows = (where: Page) =>
    where.locator('.cinder-tool-call-rail__row').filter({ hasText: /Approved by / });

  // And the chat decision is one receipt that names no place: an approval made and carried out in
  // the chat reads on its rail row, which is the answer, and draws no card under it.
  await page.goto(`/chats/${viaChat}`);
  await page.reload();
  await expect(decidedRows(page)).toHaveCount(1);
  await expect(decidedRows(page)).not.toContainText('in Reviews');
  await expect(receiptsOf(page)).toHaveCount(0);
  await expect(page.locator('[data-approval-decision]')).toHaveCount(0);
});
