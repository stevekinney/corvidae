/**
 * COR-2293 A8 (COR-2439 AC9): a chat route left while its run waits, and returned to, is the same
 * session: the return opens no second attach over the run, the approval it waits on is still there,
 * and deciding it continues the run. Against the real host, with no sleep or timer wait: every wait
 * is a web-first assertion on what the page shows or what it asked the server.
 */
import type { Page } from '@playwright/test';

import {
  conversation,
  expectWaiting,
  newThreadId,
  releaseBarrier,
  startRun,
} from './chat-support.ts';
import { expect, test } from './fixtures.ts';

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

test('a chat left while its run streams, and returned to, attaches once and carries on', async ({
  page,
  request,
}) => {
  const threadId = newThreadId('retained-route');
  const run = await startRun('barrier', threadId, 'Start the work');
  try {
    await expectWaiting(request, 1);
    const attaches = recordAttaches(page, threadId);

    await page.goto(`/chats/${threadId}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect.poll(() => attaches.length).toBe(1);

    // Leave by the application's own navigation, so the page is not reloaded.
    await page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('link', { name: /^Reviews/ })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Reviews' })).toBeVisible();

    // And come back the same way: the retained live transport is the page's again.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/chats/${threadId}$`));
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    expect(attaches).toHaveLength(1);

    await releaseBarrier(request);
    await expect(conversation(page).getByText('The barrier opened.')).toHaveCount(1);
  } finally {
    await releaseBarrier(request);
    run.abort();
  }
});
