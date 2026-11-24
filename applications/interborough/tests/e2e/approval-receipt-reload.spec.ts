/**
 * COR-2292 D6 (COR-2439 AC1): persisted decisions are rendered as exactly one receipt after a
 * reload, whether the approval was made in Reviews or in its chat. The receipt is durable server
 * state, not a client-side transition retained by the currently mounted chat.
 */
import type { Page } from '@playwright/test';

import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { approveReview, waitingReviewOf, type WaitingReview } from './task-support.ts';

test.use({ viewport: { width: 1280, height: 900 } });

const inboxAt = (review: WaitingReview): string =>
  `/reviews?review=${encodeURIComponent(`bureau:${review.id}`)}`;

const receiptsOf = (page: Page) => page.locator('[data-cinder-layout="decision"]');

test('a Reviews decision and a chat decision each have one durable receipt after reload', async ({
  page,
  request,
}) => {
  const viaReviews = newThreadId('receipt-reload-reviews');
  await runToEnd(request, 'demo:tool-runner', viaReviews, 'Refund order-1001');
  const review = await waitingReviewOf(request, viaReviews);
  await page.goto(inboxAt(review));
  await approveReview(page.locator('.ib-review-pane'));
  await expect(page.locator(`[data-review-row="bureau:${review.id}"]`)).toHaveCount(0);

  const viaChat = newThreadId('receipt-reload-chat');
  await runToEnd(request, 'demo:tool-runner', viaChat, 'Refund order-1002');
  await page.goto(`/chats/${viaChat}`);
  await page.locator('[data-approval-decision]').getByRole('button', { name: 'Approve' }).click();
  await expect(page.locator('[data-approval-decision]')).toHaveCount(0);

  await page.goto(`/chats/${viaReviews}`);
  await page.reload();
  await expect(receiptsOf(page)).toHaveCount(1);
  const reviewReceipt = receiptsOf(page);
  await expect(reviewReceipt.locator('.cinder-approval-card__settled-note')).toContainText(
    'Approved by you in Reviews',
  );
  await expect(reviewReceipt.getByRole('link', { name: 'Reviews' })).toHaveAttribute(
    'href',
    new RegExp(`/reviews\\?tab=done&review=${encodeURIComponent(`bureau:${review.id}`)}`),
  );
  await expect(page.locator('[data-approval-decision]')).toHaveCount(0);

  await page.goto(`/chats/${viaChat}`);
  await page.reload();
  await expect(receiptsOf(page)).toHaveCount(1);
  const chatReceipt = receiptsOf(page);
  await expect(chatReceipt.locator('.cinder-approval-card__settled-note')).toContainText(
    'Approved by you',
  );
  await expect(chatReceipt.locator('.cinder-approval-card__settled-note')).not.toContainText(
    'in Reviews',
  );
  await expect(chatReceipt.getByRole('link', { name: 'Reviews' })).toHaveCount(0);
  await expect(page.locator('[data-approval-decision]')).toHaveCount(0);
});
