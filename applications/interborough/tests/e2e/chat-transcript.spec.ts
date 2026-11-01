/**
 * The chat transcript's approvals and polish against the real host (COR-1984): an approval is one
 * 40px row with Show input, Deny, Approve and Allow for the rest of this chat, which sends the
 * Bureau's `remember`; a call the person denied reads Denied and is counted so, not as failed; the
 * transcript sits on the page background; and the header title draws the Markdown it was given.
 * Sessions are started through the AG-UI mount, the way a client other than the page would.
 */
import type { Page } from '@playwright/test';

import { conversation, newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';

const TOOL_RUNNER = 'demo:tool-runner';

/** A tool-runner session left waiting on the approval of its refund, the way another client leaves one. */
async function waitingSession(
  request: Parameters<typeof runToEnd>[0],
  firstMessage = 'Refund order-1001',
): Promise<string> {
  const threadId = newThreadId(TOOL_RUNNER);
  await runToEnd(request, TOOL_RUNNER, threadId, firstMessage);
  return threadId;
}

/** The decision requests the page sends to the Bureau, each as the JSON it sent. */
function recordResolutions(page: Page): Array<{ params: Record<string, unknown> }> {
  const sent: Array<{ params: Record<string, unknown> }> = [];
  page.on('request', (outgoing) => {
    if (outgoing.method() !== 'POST' || !outgoing.url().endsWith('/bureau/jsonrpc')) return;
    const body = outgoing.postDataJSON() as { method?: string; params?: Record<string, unknown> };
    if (body.method === 'bureau.reviews.resolve') sent.push({ params: body.params ?? {} });
  });
  return sent;
}

test.describe('an approval in the chat', () => {
  test('is one 40px row with Show input, Allow for the rest of this chat, Deny and Approve', async ({
    page,
    request,
    checkA11y,
  }) => {
    const threadId = await waitingSession(request);
    // Beside the chats' list the transcript is about 630px wide at 1280, which wraps the buttons
    // under the question; with room for them the row is one line.
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/chats/${threadId}`);

    const approval = page.locator('.ib-decision');
    await expect(approval).toBeVisible();
    for (const name of ['Show input', 'Allow for the rest of this chat', 'Deny', 'Approve']) {
      await expect(approval.getByRole('button', { name })).toBeVisible();
    }
    const row = await approval.locator('.ib-decision__row').boundingBox();
    expect(row?.height).toBe(40);
    await checkA11y('a chat waiting on an approval');

    // The input stays out of the row until it is asked for.
    await expect(approval.locator('.ib-decision__input')).toHaveCount(0);
    await approval.getByRole('button', { name: 'Show input' }).click();
    await expect(approval.locator('.ib-decision__input')).toContainText('orderId');
    await approval.getByRole('button', { name: 'Hide input' }).click();
    await expect(approval.locator('.ib-decision__input')).toHaveCount(0);
  });

  test('sends remember on the review when allowed for the rest of the chat, and the call is settled', async ({
    page,
    request,
  }) => {
    const threadId = await waitingSession(request);
    const sent = recordResolutions(page);
    await page.goto(`/chats/${threadId}`);
    const approval = page.locator('.ib-decision');
    const allow = approval.getByRole('button', { name: 'Allow for the rest of this chat' });
    // The grant is made on the Bureau's review, so the button waits until the reviews were read.
    await expect(allow).toBeEnabled();

    await allow.click();

    await expect(approval).toHaveCount(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.params).toMatchObject({ decision: 'approve', remember: true });
    expect(typeof sent[0]?.params['round']).toBe('number');
    // The Bureau ran the refund, and the transcript shows the call as done.
    await expect(conversation(page).getByRole('img', { name: 'Needs you' })).toHaveCount(0);
  });

  test('is plain Approve without remember when only Approve is pressed', async ({
    page,
    request,
  }) => {
    const threadId = await waitingSession(request);
    const sent = recordResolutions(page);
    await page.goto(`/chats/${threadId}`);

    await page.locator('.ib-decision').getByRole('button', { name: 'Approve' }).click();

    await expect(page.locator('.ib-decision')).toHaveCount(0);
    // A plain decision goes with the next turn, not through the reviews, so nothing is remembered.
    expect(sent.filter((request) => request.params['remember'] === true)).toHaveLength(0);
  });
});

test.describe('a denied call', () => {
  test('reads Denied, and the turn’s line counts it as denied and not failed', async ({
    page,
    request,
  }) => {
    const threadId = await waitingSession(request);
    await page.goto(`/chats/${threadId}`);

    await page.locator('.ib-decision').getByRole('button', { name: 'Deny' }).click();

    await expect(page.locator('.ib-decision')).toHaveCount(0);
    await expect(conversation(page).getByText(/Used 2 tools · 1 denied/)).toBeVisible();
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(conversation(page).getByRole('img', { name: 'Denied' })).toBeVisible();
    await expect(conversation(page).getByRole('img', { name: 'Failed' })).toHaveCount(0);
    await expect(conversation(page).getByText(/failed/)).toHaveCount(0);
  });
});

test.describe('the transcript', () => {
  test('sits on the page background, not on the inset surface of the sidebar', async ({
    page,
    request,
  }) => {
    const threadId = await waitingSession(request);
    await page.goto(`/chats/${threadId}`);
    await expect(page.locator('.ib-decision')).toBeVisible();

    const backgrounds = await page.evaluate(() => {
      const paint = (selector: string): string | undefined => {
        const element = document.querySelector(selector);
        return element === null ? undefined : getComputedStyle(element).backgroundColor;
      };
      return { timeline: paint('.chat-timeline'), sidebar: paint('[data-sidebar], .ib-sidebar') };
    });
    // The timeline paints nothing of its own, so the page shows through it.
    expect(backgrounds.timeline).toBe('rgba(0, 0, 0, 0)');
  });

  test('titles the chat with the Markdown its first message carried, drawn and not typed out', async ({
    page,
    request,
  }) => {
    const threadId = await waitingSession(request, 'Refund **order-1001** and `issue-refund`');
    await page.goto(`/chats/${threadId}`);

    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading.locator('strong')).toHaveText('order-1001');
    await expect(heading.locator('code')).toHaveText('issue-refund');
    await expect(heading).not.toContainText('**');
    await expect(heading).not.toContainText('`');
  });
});
