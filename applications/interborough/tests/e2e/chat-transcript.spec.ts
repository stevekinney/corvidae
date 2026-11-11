/**
 * The chat transcript's approvals and polish against the real host (COR-1984): an approval is one
 * 40px row with Show input, Deny, Approve and Allow for the rest of this chat, which resumes the run
 * with `remember` as Approve does (COR-1990); a call the person denied reads Denied and is counted so, not as failed; the
 * transcript sits on the page background; and the header title draws the Markdown it was given.
 * Sessions are started through the AG-UI mount, the way a client other than the page would.
 */
import type { Page } from '@playwright/test';

import { conversation, deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { E2E_BARRIER_URL, E2E_BUREAU_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const TOOL_RUNNER = 'demo:tool-runner';
const CHAT_PROOF_PARENT = 'e2e:chat-proof-parent';
const CHAT_PROOF_CHILD = 'e2e:workflow-reviewer';

/** A tool-runner session left waiting on the approval of its refund, the way another client leaves one. */
async function waitingSession(
  request: Parameters<typeof runToEnd>[0],
  firstMessage = 'Refund order-1001',
): Promise<string> {
  const threadId = newThreadId(TOOL_RUNNER);
  await runToEnd(request, TOOL_RUNNER, threadId, firstMessage);
  return threadId;
}

/** One entry of a resume, as the page sent it. */
type SentEntry = { interruptId: string; payload?: Record<string, unknown>; metadata?: unknown };

/** The resume entries the page sends to the AG-UI mount, each run's entries in order. */
function recordResumes(page: Page): SentEntry[][] {
  const sent: SentEntry[][] = [];
  page.on('request', (outgoing) => {
    if (outgoing.method() !== 'POST' || !outgoing.url().includes('/agents/')) return;
    const body = outgoing.postDataJSON() as { resume?: SentEntry[] } | null;
    if (body?.resume !== undefined) sent.push(body.resume);
  });
  return sent;
}

/** The reviews resolved through `bureau.reviews.resolve`, which a chat's decision no longer uses. */
function recordResolutions(page: Page): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  page.on('request', (outgoing) => {
    if (outgoing.method() !== 'POST' || !outgoing.url().endsWith('/bureau/jsonrpc')) return;
    const body = outgoing.postDataJSON() as { method?: string; params?: Record<string, unknown> };
    if (body.method === 'bureau.reviews.resolve') sent.push(body.params ?? {});
  });
  return sent;
}

test.describe('an approval in the chat', () => {
  test('is Cinder’s approval row: Input, a note, Allow for the rest of this chat, Deny and Approve', async ({
    page,
    request,
    checkA11y,
  }) => {
    const threadId = await waitingSession(request);
    // Beside the chats' list the transcript is about 630px wide at 1280, which wraps the buttons
    // under the question; with room for them the row is one line.
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`/chats/${threadId}`);

    const approval = page.locator('[data-approval-decision]');
    await expect(approval).toBeVisible();
    // Cinder's shared approval row: the Input disclosure, a note on request, the grant for the rest
    // of the chat as a checkbox on its own line, then Deny and Approve.
    for (const name of ['Input', 'Add a note', 'Deny', 'Approve']) {
      await expect(approval.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(
      approval.getByRole('checkbox', { name: /^Allow .* for the rest of this chat$/ }),
    ).toBeVisible();
    await checkA11y('a chat waiting on an approval');

    // The input stays out of the row until it is asked for.
    const input = approval.getByRole('button', { name: /^Input/ });
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await input.click();
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await expect(approval).toContainText('Order ID');
    await input.click();
    await expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  test('resumes the run with remember when allowed for the rest of the chat, and the call is settled', async ({
    page,
    request,
  }) => {
    const threadId = await waitingSession(request);
    const resumes = recordResumes(page);
    const resolutions = recordResolutions(page);
    await page.goto(`/chats/${threadId}`);
    const approval = page.locator('[data-approval-decision]');
    const allow = approval.getByRole('checkbox', { name: /^Allow .* for the rest of this chat$/ });
    await expect(allow).toBeEnabled();

    await allow.check();
    await approval.getByRole('button', { name: 'Approve' }).click();

    await expect(approval).toHaveCount(0);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toHaveLength(1);
    expect(resumes[0]?.[0]?.payload).toEqual({
      decision: 'approve',
      remember: true,
      decisionSurface: 'chat',
    });
    expect(resumes[0]?.[0]?.metadata).toMatchObject({
      '@lostgradient/bureau': { round: expect.any(Number) },
    });
    expect(resolutions).toEqual([]);
    // The Bureau ran the refund, and the transcript shows the call as done.
    await expect(conversation(page).getByRole('img', { name: 'Needs you' })).toHaveCount(0);
  });

  test('is plain Approve without remember when only Approve is pressed', async ({
    page,
    request,
  }) => {
    const threadId = await waitingSession(request);
    const resumes = recordResumes(page);
    await page.goto(`/chats/${threadId}`);

    await page.locator('[data-approval-decision]').getByRole('button', { name: 'Approve' }).click();

    await expect(page.locator('[data-approval-decision]')).toHaveCount(0);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.[0]?.payload).toEqual({ decision: 'approve', decisionSurface: 'chat' });
  });
});

test.describe('a denied call', () => {
  test('reads Denied, and the turn’s line counts it as denied and not failed', async ({
    page,
    request,
  }) => {
    const threadId = await waitingSession(request);
    await page.goto(`/chats/${threadId}`);

    await page.locator('[data-approval-decision]').getByRole('button', { name: 'Deny' }).click();

    await expect(page.locator('[data-approval-decision]')).toHaveCount(0);
    await expect(
      conversation(page).locator('.cinder-tool-call-rail__item[data-cinder-status="denied"]'),
    ).toBeVisible();
    await expect(
      conversation(page).locator('.cinder-tool-call-rail__item[data-cinder-status="failed"]'),
    ).toHaveCount(0);
    await expect(conversation(page).getByText(/failed/i)).toHaveCount(0);
  });
});

test.describe('the transcript', () => {
  test('sits on the page background, not on the inset surface of the sidebar', async ({
    page,
    request,
  }) => {
    const threadId = await waitingSession(request);
    await page.goto(`/chats/${threadId}`);
    await expect(page.locator('[data-approval-decision]')).toBeVisible();

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

test('shows a durable specialist child while held, then restores its completed card after reload', async ({
  page,
  request,
}) => {
  let parentId: string | undefined;
  let childRunId: string | undefined;
  try {
    await page.goto(`${E2E_BUREAU_URL}/chats/new?agent=${encodeURIComponent(CHAT_PROOF_PARENT)}`);
    await page.getByRole('textbox').fill('Review the fixture workflow');
    await page.getByRole('textbox').press('Enter');
    await expect(page).toHaveURL(/\/chats\/(?!new(?:$|\?))[^/?]+$/);
    parentId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '');
    const parentUrl = page.url();
    const childLink = conversation(page).getByRole('link', { name: 'View run' });
    await expect(childLink).toHaveCount(1);
    await expect(conversation(page).getByText(CHAT_PROOF_CHILD, { exact: true })).toHaveCount(1);
    // The child's card says Running once; the heading above the transcript says it too, for the chat.
    await expect(
      page.getByRole('region', { name: 'Chat conversation' }).getByText('Running', { exact: true }),
    ).toHaveCount(1);
    const childHref = await childLink.getAttribute('href');
    expect(childHref).toMatch(/^\/runs\/[^/]+$/);
    childRunId = childHref?.slice('/runs/'.length);
    if (childRunId === undefined) throw new Error('The child card did not link to a child run.');

    await expect
      .poll(async () => {
        const response = await request.get(
          `${E2E_BARRIER_URL}/chat-proof/waiting?childRunId=${encodeURIComponent(childRunId as string)}`,
        );
        return ((await response.json()) as { waiting: boolean }).waiting;
      })
      .toBe(true);

    const release = await request.post(`${E2E_BARRIER_URL}/chat-proof/release`, {
      data: { childRunId },
    });
    expect(release.ok()).toBe(true);
    await expect(conversation(page).getByText('Finished', { exact: true })).toHaveCount(1);

    const childMessageRequests: string[] = [];
    page.on('request', (outgoing) => {
      if (outgoing.url().includes(`/bureau/ag-ui/threads/${childRunId}/messages`)) {
        childMessageRequests.push(outgoing.url());
      }
    });
    await childLink.click();
    await expect(page).toHaveURL(new RegExp(`/runs/${childRunId}$`));
    const details = page.getByRole('complementary', { name: 'Details' });
    await expect(details.locator(`code[title="${childRunId}"]`)).toHaveCount(1);
    await expect(details.getByRole('link', { name: 'Review the fixture workflow' })).toBeVisible();
    expect(childMessageRequests).toEqual([]);

    await page.goto(parentUrl);
    await page.reload();
    const restoredLink = conversation(page).getByRole('link', { name: 'View run' });
    await expect(restoredLink).toHaveCount(1);
    await expect(conversation(page).getByText(CHAT_PROOF_CHILD, { exact: true })).toHaveCount(1);
    await expect(conversation(page).getByText('Finished', { exact: true })).toHaveCount(1);
    await expect(restoredLink).toHaveAttribute('href', `/runs/${childRunId}`);
  } finally {
    if (childRunId !== undefined) {
      await request.post(`${E2E_BARRIER_URL}/chat-proof/release`, { data: { childRunId } });
    }
    if (parentId !== undefined) await deleteChats([parentId], E2E_BUREAU_URL);
  }
});
