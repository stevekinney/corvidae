/**
 * COR-2293 A8 (COR-2439 AC9): a chat route left while its run waits, and returned to, is the same
 * session: the return opens no second attach over the run, the approval it waits on is still there,
 * and deciding it continues the run. Against the real host, with no sleep or timer wait: every wait
 * is a web-first assertion on what the page shows or what it asked the server.
 */
import type { Page } from '@playwright/test';

import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { threadMessages } from './task-support.ts';

test.use({ viewport: { width: 1280, height: 900 } });

/** The attach GETs a page makes for `threadId`: the requests that join its run. */
function recordAttaches(page: Page, threadId: string): string[] {
  const attaches: string[] = [];
  const path = `/ag-ui/threads/${encodeURIComponent(threadId)}/run`;
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith(path)) {
      attaches.push(request.url());
    }
  });
  return attaches;
}

/** The demo provider writes this durable marker when it accepted and completed a refund. */
function refundRan(messages: unknown[]): boolean {
  return JSON.stringify(messages).includes('provider-pending');
}

test('a chat left while its run waits, and returned to, attaches once and carries on', async ({
  page,
  request,
}) => {
  const threadId = newThreadId('retained-route');
  // The run parks on the refund's approval, so it is still waiting when the page leaves it.
  await runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001');
  const attaches = recordAttaches(page, threadId);

  await page.goto(`/chats/${threadId}`);
  const approval = page.locator('[data-approval-decision]');
  await expect(approval).toBeVisible();
  await expect.poll(() => attaches.length).toBe(1);

  // Leave by the application's own navigation, so the page is not reloaded.
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: /^Reviews/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Reviews' })).toBeVisible();
  await expect(approval).toHaveCount(0);

  // And come back the same way: the retained session is the page's again.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/chats/${threadId}$`));
  await expect(approval).toBeVisible();
  await expect(approval.getByRole('heading', { level: 4 })).toHaveText(
    'Refund order order-1001 for 4200 minor units (USD)?',
  );
  expect(attaches).toHaveLength(1);

  // Deciding it on the returned page continues the run.
  await approval.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(async () => refundRan(await threadMessages(request, threadId))).toBe(true);
});
