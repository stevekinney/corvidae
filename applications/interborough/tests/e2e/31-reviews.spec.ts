/**
 * `/reviews` against the real host: one inbox of the Bureau's tool approvals and questions and the
 * engine's workflow reviews, a list with the open review beside it. Approving `tool-runner`'s
 * review runs its tool, by the button or by A; Deny sends the note, by the button or by D; Allow
 * for the rest of this chat sends `remember`; a chat that is already open agrees about an approval
 * whichever one decides it, within a few seconds and with no reload; and a question is answered in
 * place. What was decided is under Done. Sessions are started through the AG-UI mount, the way a
 * client other than the page would.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { HUMAN_INPUT_PROMPT } from '@lostgradient/plugin-demo';
import { REVIEWS_COPY } from '../../src/app/copy/reviews.ts';
import { conversation, newThreadId, runToEnd, untilChatLoaded } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, holdBureauFeed, loggedFailedResponse, test } from './fixtures.ts';
import {
  bureauCall,
  taskOfSession,
  threadMessages,
  waitingReviewOf,
  type WaitingReview,
} from './task-support.ts';

const WIDTHS = [375, 1280] as const;
const REFUND_APPROVAL = {
  toolName: 'issue-refund',
  question: 'Refund order 4471 for $42.00?',
  arguments: { orderId: '4471', amount: '$42.00', reason: 'Arrived damaged' },
  risk: 'high',
} as const;
const TRIAGE_APPROVAL = {
  toolName: 'triage-refunds',
  question: 'Triage refund request for order 4398?',
  arguments: { orderId: '4398', amount: '$27.25', reason: 'Arrived damaged' },
  risk: 'medium',
} as const;
type ApprovalCaptureFixture = typeof REFUND_APPROVAL | typeof TRIAGE_APPROVAL;

// Wide enough that the list and the open review show side by side (ListDetail shows one pane at a
// time below 900 pixels of its own width), so a row is on the page while its review is open.
test.use({ viewport: { width: 1600, height: 900 } });

const composer = (page: Page) => page.getByRole('textbox');

async function send(page: Page, text: string): Promise<void> {
  await untilChatLoaded(page);
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** The session a new chat became once its first run began: the address replaces `/chats/new`. */
async function sessionOf(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/chats\/(?!new)[^/?]+$/);
  return decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
}

/** The AG-UI start requests a page makes, each as the JSON it sent. */
function recordStarts(page: Page): Array<{ messages: unknown[]; resume?: unknown[] }> {
  const starts: Array<{ messages: unknown[]; resume?: unknown[] }> = [];
  page.on('request', (outgoing) => {
    if (outgoing.method() === 'POST' && outgoing.url().includes('/ag-ui/agents/')) {
      starts.push(outgoing.postDataJSON());
    }
  });
  return starts;
}

/** The `bureau.reviews.resolve` calls a page makes, each as the params it sent. */
function recordResolves(page: Page): Array<Record<string, unknown>> {
  const resolves: Array<Record<string, unknown>> = [];
  page.on('request', (outgoing) => {
    if (outgoing.method() !== 'POST' || !outgoing.url().includes('/jsonrpc')) return;
    const body = outgoing.postDataJSON() as { method?: string; params?: Record<string, unknown> };
    if (body.method === 'bureau.reviews.resolve') resolves.push(body.params ?? {});
  });
  return resolves;
}

/** The address of the inbox with `review` open: the key the list selects it by. */
const inboxAt = (review: WaitingReview, tab?: 'done'): string =>
  `/reviews?${tab === undefined ? '' : `tab=${tab}&`}review=${encodeURIComponent(`bureau:${review.id}`)}`;

/** The row of a Bureau review in the list. */
const rowOf = (page: Page, review: WaitingReview) =>
  page.locator(`[data-review-row="bureau:${review.id}"]`);

/** The open review detail, whether it is a shared approval card or a question/workflow pane. */
const paneOf = (page: Page) => page.locator('.ib-reviews__detail');

/** Whether a tool result in a conversation carries `refundedCents`, which only a refund that ran does. */
function refundRan(messages: unknown[]): boolean {
  return JSON.stringify(messages).includes('refundedCents');
}

/** Supplies the board's sample copy and arguments on the real review's read response. */
async function useApprovalCaptureFixture(
  page: Page,
  review: WaitingReview,
  fixture: ApprovalCaptureFixture,
): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const call = route.request().postDataJSON() as { method?: string };
    if (call.method !== 'bureau.reviews.list') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as {
      result?: {
        reviews?: Array<{
          id: string;
          approval?: { action: Record<string, unknown> };
        }>;
      };
    };
    if (body.result?.reviews === undefined) return route.fulfill({ response });
    await route.fulfill({
      response,
      json: {
        ...body,
        result: {
          ...body.result,
          reviews: body.result.reviews.map((candidate) => {
            if (candidate.id !== review.id || candidate.approval === undefined) return candidate;
            return {
              ...candidate,
              approval: {
                ...candidate.approval,
                toolName: fixture.toolName,
                arguments: fixture.arguments,
                action: {
                  ...candidate.approval.action,
                  message: fixture.question,
                  risk: fixture.risk,
                },
              },
            };
          }),
        },
      },
    });
  });
}

/** Set the actual demo tool's policy and restore its versioned override afterwards. */
async function withAlwaysRefundMode(
  request: APIRequestContext,
  exercise: () => Promise<void>,
): Promise<void> {
  const id = 'demo:tool-runner';
  const tool = 'issue-refund';
  const { hash, overrides, ownTools } = (await bureauCall(request, 'bureau.agents.overrides.get', {
    id,
  })) as { hash: string; overrides: Record<string, unknown>; ownTools: string[] };
  expect(ownTools).toContain(tool);
  const { hash: appliedHash } = (await bureauCall(request, 'bureau.agents.overrides.update', {
    id,
    expectedHash: hash,
    overrides: { ...overrides, approvals: { [tool]: 'always' } },
  })) as { hash: string };
  try {
    const readback = (await bureauCall(request, 'bureau.agents.overrides.get', { id })) as {
      overrides: Record<string, unknown>;
    };
    expect(readback.overrides['approvals']).toMatchObject({ [tool]: 'always' });
    await exercise();
  } finally {
    await bureauCall(request, 'bureau.agents.overrides.update', {
      id,
      expectedHash: appliedHash,
      overrides,
    });
  }
}

/** Starts a refund run that waits on its approval, and opens the inbox on it. */
async function waitingRefund(
  page: Page,
  request: APIRequestContext,
  name: string,
  fixture?: ApprovalCaptureFixture,
): Promise<{ threadId: string; review: WaitingReview }> {
  const threadId = newThreadId(name);
  await runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001');
  expect(refundRan(await threadMessages(request, threadId))).toBe(false);
  const review = await waitingReviewOf(request, threadId);
  if (fixture !== undefined) await useApprovalCaptureFixture(page, review, fixture);
  await page.goto(inboxAt(review));
  await expect(paneOf(page)).toContainText(
    fixture?.question ?? 'Refund order order-1001 for $42.00?',
  );
  return { threadId, review };
}

/** Captures an approval in the two board widths, restoring the suite's desktop viewport afterwards. */
async function captureApprovalAtWidths(
  page: Page,
  state: string,
  actions: readonly string[] = ['Deny', 'Approve'],
): Promise<void> {
  const originalViewport = page.viewportSize();
  if (originalViewport === null) throw new Error('The Reviews test requires a viewport.');
  try {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 375) {
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
      for (const name of actions) {
        const action = paneOf(page).getByRole('button', { name, exact: true });
        await expect(action).toBeVisible();
        if (width === 375) {
          await expect
            .poll(async () => {
              const box = await action.boundingBox();
              return box === null ? 0 : Math.min(box.height, box.width);
            })
            .toBeGreaterThanOrEqual(44);
        }
      }
      await captureForDesignReview(page, {
        route: '/reviews',
        state,
        source: '31-reviews.spec.ts',
      });
    }
  } finally {
    await page.setViewportSize(originalViewport);
  }
}

test.describe('a tool approval', () => {
  test('approved from the inbox runs the tool, and its row goes', async ({
    page,
    request,
    checkA11y,
  }) => {
    const threadId = newThreadId('reviews-approve');
    await runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001');
    expect(refundRan(await threadMessages(request, threadId))).toBe(false);
    const review = await waitingReviewOf(request, threadId);

    await page.goto('/reviews');
    // The list is the question itself, longest waiting first, and the oldest waiting review is
    // open on arrival (COR-2017); a row opens its own review.
    await expect(rowOf(page, review)).toContainText('Refund order order-1001 for $42.00?');
    await expect(paneOf(page)).toHaveCount(1);
    await rowOf(page, review).click();
    // The click opened this review: its id is the one in the address.
    await expect(page).toHaveURL(inboxAt(review));

    // The pane says what is asked, who asked it, and what the call was given, and where from.
    await expect(paneOf(page)).toContainText('Refund order order-1001 for $42.00?');
    const source = paneOf(page).getByTestId('review-source');
    await expect(source).toContainText('Asked by');
    await expect(source.getByRole('link', { name: /tool runner/i })).toBeVisible();
    await expect(source).toContainText(/waiting \d+ (min|h|days?)/);
    await expect(paneOf(page)).toContainText('order-1001');
    // No raw policy string, no Live toggle, and no separate section for the engine's reviews.
    await expect(page.getByText(/requires approval/)).toHaveCount(0);
    await expect(page.locator('main').getByLabel('Live', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Workflow reviews', { exact: true })).toHaveCount(0);
    await checkA11y('a tool approval in the inbox');
    await paneOf(page).getByRole('button', { name: 'Approve' }).click();

    await expect(rowOf(page, review)).toHaveCount(0);
    // The row going is not the evidence: the tool ran, and its result is in the conversation.
    await expect.poll(async () => refundRan(await threadMessages(request, threadId))).toBe(true);
  });

  test('denied from the inbox with a note never runs the tool', async ({ page, request }) => {
    const { threadId, review } = await waitingRefund(page, request, 'reviews-reject');
    const resolves = recordResolves(page);
    await paneOf(page)
      .getByRole('textbox', { name: 'Note (optional)', exact: true })
      .fill('Wrong customer.');
    await paneOf(page).getByRole('button', { name: 'Deny' }).click();

    await expect(rowOf(page, review)).toHaveCount(0);
    expect(resolves[0]).toMatchObject({
      id: review.id,
      decision: 'reject',
      reason: 'Wrong customer.',
    });
    expect(refundRan(await threadMessages(request, threadId))).toBe(false);
  });

  test('A approves the open approval and D denies it with the note typed, and neither acts while a field is typed in', async ({
    page,
    request,
  }) => {
    const approved = await waitingRefund(page, request, 'reviews-key-approve');
    // Typing an "a" or a "d" into the note is typing, not a decision.
    const note = paneOf(page).getByRole('textbox', { name: 'Note (optional)', exact: true });
    await note.fill('');
    await note.press('a');
    await note.press('d');
    await expect(note).toHaveValue('ad');
    await expect(rowOf(page, approved.review)).toBeVisible();

    await note.fill('');
    await paneOf(page).getByRole('heading', { level: 2 }).click();
    await page.keyboard.press('a');
    await expect(rowOf(page, approved.review)).toHaveCount(0);
    await expect
      .poll(async () => refundRan(await threadMessages(request, approved.threadId)))
      .toBe(true);

    const denied = await waitingRefund(page, request, 'reviews-key-deny');
    const resolves = recordResolves(page);
    await paneOf(page)
      .getByRole('textbox', { name: 'Note (optional)', exact: true })
      .fill('Not this one.');
    await paneOf(page).getByRole('heading', { level: 2 }).click();
    await page.keyboard.press('d');
    await expect(rowOf(page, denied.review)).toHaveCount(0);
    expect(resolves[0]).toMatchObject({
      id: denied.review.id,
      decision: 'reject',
      reason: 'Not this one.',
    });
    expect(refundRan(await threadMessages(request, denied.threadId))).toBe(false);
  });

  test('shared Reviews approval detail remembers an On changes approval only when approved', async ({
    page,
    request,
  }) => {
    const { threadId, review } = await waitingRefund(page, request, 'reviews-remember');
    const resolves = recordResolves(page);
    const remember = paneOf(page).getByRole('checkbox', {
      name: /allow .* for the rest of this chat/i,
    });
    await remember.check();
    await expect.poll(() => resolves).toHaveLength(0);
    await paneOf(page).getByRole('button', { name: 'Approve' }).click();

    await expect(rowOf(page, review)).toHaveCount(0);
    expect(resolves[0]).toMatchObject({ id: review.id, decision: 'approve', remember: true });
    await expect.poll(async () => refundRan(await threadMessages(request, threadId))).toBe(true);
  });

  test('shared Reviews approval detail captures a pending On changes approval', async ({
    page,
    request,
  }) => {
    await waitingRefund(page, request, 'reviews-capture-on-changes', TRIAGE_APPROVAL);
    await captureApprovalAtWidths(page, 'pending On changes approval');
  });

  test('shared Reviews approval detail captures a pending Always approval', async ({
    page,
    request,
  }) => {
    await withAlwaysRefundMode(request, async () => {
      await waitingRefund(page, request, 'reviews-capture-always', REFUND_APPROVAL);
      const pane = paneOf(page);
      await expect(pane.getByRole('heading', { level: 2 })).toHaveText(REFUND_APPROVAL.question);
      for (const label of ['Order ID', 'Amount', 'Reason']) {
        await expect(pane.getByText(label, { exact: true })).toBeVisible();
      }
      await expect(pane).toContainText('Arrived damaged');
      await expect(pane).toContainText("Can't be undone.");
      await expect(pane.getByRole('checkbox')).toHaveCount(0);
      await captureApprovalAtWidths(page, 'pending Always approval');
    });
  });

  for (const [decision, active, other] of [
    ['Approve', 'Approving…', 'Deny'],
    ['Deny', 'Denying…', 'Approve'],
  ] as const) {
    test(`/reviews shared Reviews approval detail captures ${decision} held and failing`, async ({
      page,
      request,
    }) => {
      await withAlwaysRefundMode(request, async () => {
        const { review, threadId } = await waitingRefund(
          page,
          request,
          'reviews-capture-held',
          REFUND_APPROVAL,
        );
        const requests = recordResolves(page);
        const release = Promise.withResolvers<void>();
        let failedOnce = false;
        const failureTitle =
          REVIEWS_COPY.approvalFailed[decision === 'Approve' ? 'approve' : 'deny'];
        // The first decision is rejected here before reaching the Bureau. This fixture can say
        // what did not happen. The page relies on the actual failure message for live responses.
        const reason =
          decision === 'Approve'
            ? 'Interborough couldn’t reach the agent. Nothing was refunded.'
            : 'Interborough couldn’t reach the agent. Nothing changed.';
        await page.route('**/jsonrpc', async (route) => {
          const call = route.request().postDataJSON() as {
            method?: string;
            id?: string;
            params?: { id?: string };
          };
          if (call.method !== 'bureau.reviews.resolve' || call.params?.id !== review.id) {
            return route.fallback();
          }
          if (failedOnce) return route.fallback();
          failedOnce = true;
          await release.promise;
          await route.fulfill({
            json: { jsonrpc: '2.0', id: call.id, error: { code: -32603, message: reason } },
          });
        });
        const pane = paneOf(page);
        await expect(pane.getByRole('checkbox')).toHaveCount(0);
        try {
          await pane.getByRole('button', { name: decision, exact: true }).click();
          await expect(pane.getByRole('button', { name: active, exact: true })).toHaveAttribute(
            'aria-busy',
            'true',
          );
          await expect(pane.getByRole('button', { name: other, exact: true })).toBeDisabled();
          await expect(pane.getByRole('checkbox')).toHaveCount(0);
          await page.keyboard.press(decision === 'Approve' ? 'd' : 'a');
          expect(requests).toHaveLength(1);
          await captureApprovalAtWidths(page, `${decision} in flight`, [active, other]);
        } finally {
          release.resolve();
        }
        await expect(pane.getByText(failureTitle, { exact: true })).toBeVisible();
        await expect(pane).toContainText(reason);
        await expect(page.locator('.cinder-toast-region').getByText(reason)).toHaveCount(0);
        await expect(pane.getByRole('button', { name: decision, exact: true })).toBeEnabled();
        await expect(pane.getByRole('checkbox')).toHaveCount(0);
        await expect(rowOf(page, review)).toBeVisible();
        expect(refundRan(await threadMessages(request, threadId))).toBe(false);
        expect(requests).toHaveLength(1);
        await captureApprovalAtWidths(page, `${decision} failing`);
        await pane.getByRole('button', { name: decision, exact: true }).click();
        await expect(rowOf(page, review)).toHaveCount(0);
        expect(requests).toHaveLength(2);
      });
    });
  }

  test('decided in the chat is gone from the inbox once the run goes on', async ({
    page,
    request,
  }) => {
    const threadId = newThreadId('reviews-chat-first');
    await runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001');
    const review = await waitingReviewOf(request, threadId);

    await page.goto('/reviews');
    await expect(rowOf(page, review)).toBeVisible();

    await page.goto(`/chats/${threadId}`);
    await page.locator('[data-approval-decision]').getByRole('button', { name: 'Approve' }).click();
    // The run goes on after the approval and reports what it did.
    await expect(conversation(page).getByText('Order order-1001 was refunded.')).toBeVisible();

    await page.goto('/reviews');
    await expect(page.getByRole('heading', { level: 1, name: 'Reviews' })).toBeVisible();
    await expect(rowOf(page, review)).toHaveCount(0);
    const listed = (await bureauCall(request, 'bureau.reviews.list', {})) as {
      reviews: Array<{ sessionId?: string }>;
    };
    expect(listed.reviews.filter((candidate) => candidate.sessionId === threadId)).toEqual([]);
  });

  test('decided in the inbox shows its result when the chat is opened, and not the approval', async ({
    page,
    request,
  }) => {
    const { threadId, review } = await waitingRefund(page, request, 'reviews-inbox-first');
    await paneOf(page).getByRole('button', { name: 'Approve' }).click();
    await expect(rowOf(page, review)).toHaveCount(0);

    // A chat opened afterwards reads the conversation the decision wrote into.
    await page.goto(`/chats/${threadId}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Refund order-1001');
    await expect(page.locator('[data-approval-decision]')).toHaveCount(0);
    // The refund shows as a tool call that succeeded, with its result in the call's panel.
    const refund = page.locator('[data-cinder-tool-call-row]').filter({ hasText: 'Issue refund' });
    await expect(refund).toBeVisible();
    await refund.click();
    const result = page
      .getByRole('complementary', { name: /Issue refund/ })
      .getByRole('region', { name: 'Result' });
    await expect(result.getByRole('term').filter({ hasText: 'Refunded cents' })).toBeVisible();
    await expect(result.getByRole('definition').filter({ hasText: '4200' })).toBeVisible();
  });

  test('decided in the inbox updates a chat that is already open, with no reload', async ({
    page,
    request,
    context,
  }) => {
    const threadId = newThreadId('reviews-open-chat');
    await runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001');
    const review = await waitingReviewOf(request, threadId);
    await page.goto(`/chats/${threadId}`);
    await expect(page.locator('[data-approval-decision]')).toContainText(
      'Refund order order-1001 for $42.00?',
    );

    const inbox = await context.newPage();
    await inbox.goto(inboxAt(review));
    await paneOf(inbox).getByRole('button', { name: 'Approve' }).click();
    await expect(rowOf(inbox, review)).toHaveCount(0);

    // The page that was already open reads the decision within five seconds.
    await expect(page.locator('[data-approval-decision]')).toHaveCount(0);
    await expect(page.getByText('1 run is waiting on you')).toHaveCount(0);
  });

  test('/reviews shared Reviews approval detail is listed under Done with its decision and note', async ({
    page,
    request,
  }) => {
    const { review } = await waitingRefund(page, request, 'reviews-done', REFUND_APPROVAL);
    const note = 'Confirmed with the customer.';
    await paneOf(page).getByRole('textbox', { name: 'Note (optional)' }).fill(note);
    await paneOf(page).getByRole('button', { name: 'Approve' }).click();
    await expect(rowOf(page, review)).toHaveCount(0);

    await page.goto(inboxAt(review, 'done'));
    await expect(rowOf(page, review)).toContainText('Approved');
    await expect(paneOf(page)).toContainText('Approved');
    await expect(paneOf(page)).toContainText(note);
    await expect(paneOf(page).getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(paneOf(page).getByRole('button', { name: 'Deny' })).toHaveCount(0);
    await captureApprovalAtWidths(page, 'Done with decision and note', []);
    // Done is read through the same list, asked for what was resolved.
    await page.getByRole('radio', { name: /^Waiting/ }).click();
    await expect(page).not.toHaveURL(/tab=done/);
    await expect(rowOf(page, review)).toHaveCount(0);
  });
});

test.describe('a decision made in the inbox', () => {
  test('reaches the chat tab that started the run, which was never reloaded', async ({
    page,
    request,
    context,
  }) => {
    // The run is started from this page, not found waiting: its first read of the pending reviews
    // can be the shared, cached one that predates the review, and must not take the call as decided.
    await page.goto('/chats/new?agent=demo:tool-runner');
    await send(page, 'Refund order 1234');
    await expect(page.locator('[data-approval-decision]')).toBeVisible();
    const threadId = await sessionOf(page);
    const review = await waitingReviewOf(request, threadId);

    const inbox = await context.newPage();
    await inbox.goto(inboxAt(review));
    await paneOf(inbox).getByRole('button', { name: 'Approve' }).click();
    await expect(rowOf(inbox, review)).toHaveCount(0);

    await expect(page.locator('[data-approval-decision]')).toHaveCount(0);
  });

  test('settles a question in a chat that never reloaded: it is gone, the next message is a normal turn, and a second question is settled the same way', async ({
    page,
    request,
    context,
  }) => {
    const starts = recordStarts(page);
    const asked = page.locator('.weft-chat-question').filter({ hasText: HUMAN_INPUT_PROMPT });
    await page.goto('/chats/new?agent=demo:request-human-input');
    await send(page, 'Release it');
    await expect(asked).toBeVisible();
    const threadId = await sessionOf(page);

    const inbox = await context.newPage();
    const answer = async (text: string) => {
      const review = await waitingReviewOf(request, threadId);
      await inbox.goto(inboxAt(review));
      await paneOf(inbox).getByLabel('Your answer').fill(text);
      await paneOf(inbox).getByRole('button', { name: 'Send', exact: true }).click();
      await expect(rowOf(inbox, review)).toHaveCount(0);
    };
    await answer('staging');
    await expect(asked).toHaveCount(0);

    // The question is settled, so this is a message and not its answer: no resume, no refusal.
    await send(page, 'Another one');
    await expect(asked).toBeVisible();
    const last = starts.at(-1);
    expect(last?.resume ?? []).toEqual([]);
    expect(JSON.stringify(last?.messages)).toContain('Another one');
    await expect(page.getByText(/was not found/)).toHaveCount(0);

    // The second question is settled elsewhere too, and the chat reads it again.
    await answer('production');
    await expect(asked).toHaveCount(0);
  });
});

test.describe('/reviews: a question a run asks', () => {
  test('is answered in the inbox in the shape it asks for, and the run goes on', async ({
    page,
    request,
    checkA11y,
  }) => {
    const threadId = newThreadId('reviews-question');
    await runToEnd(request, 'demo:request-human-input', threadId, 'Release it');
    const review = await waitingReviewOf(request, threadId);

    await page.goto(inboxAt(review));
    await expect(rowOf(page, review)).toContainText(HUMAN_INPUT_PROMPT);
    await expect(paneOf(page)).toContainText(HUMAN_INPUT_PROMPT);
    await expect(paneOf(page).getByTestId('review-source')).toContainText(
      /Asked by .*request human input/i,
    );
    await expect(paneOf(page)).toContainText('The agent continues as soon as you answer.');
    await checkA11y('a question in the inbox');
    const originalViewport = page.viewportSize();
    if (originalViewport === null) throw new Error('The Reviews test requires a viewport.');
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await expect(paneOf(page).getByLabel('Your answer')).toBeVisible();
      await expect(paneOf(page).getByRole('button', { name: 'Send', exact: true })).toBeVisible();
      await captureForDesignReview(page, {
        route: '/reviews',
        state: 'pending human question',
        source: '31-reviews.spec.ts',
      });
    }
    await page.setViewportSize(originalViewport);
    await paneOf(page).getByLabel('Your answer').fill('staging');
    await paneOf(page).getByRole('button', { name: 'Send', exact: true }).click();

    await expect(rowOf(page, review)).toHaveCount(0);
    const task = await taskOfSession(request, threadId);
    await expect
      .poll(
        async () =>
          (
            (await bureauCall(request, 'bureau.tasks.get', {
              taskId: task.id,
            })) as {
              status: string;
            }
          ).status,
      )
      .toBe('completed');

    // What was answered is under Done, as answered, and the answer itself is not shown.
    await page.goto(inboxAt(review, 'done'));
    await expect(rowOf(page, review)).toContainText('Answered');
    await expect(paneOf(page).getByTestId('review-resolution')).toContainText(
      'The answer was sent to the agent.',
    );
    await expect(paneOf(page).getByLabel('Your answer')).toHaveCount(0);
  });
});

test.describe('a scheduled run’s human wait', () => {
  test('answered in the inbox lets that run continue', async ({ page, request }) => {
    // A schedule whose agent asks a question. A fire that is still going is not fired over
    // (`overlap: 'skip'`), so the first fire is the only one while its question is open.
    const schedule = (await bureauCall(request, 'bureau.schedules.create', {
      agentName: 'demo:request-human-input',
      spec: '1s',
      input: 'Ask which environment the scheduled release goes to',
      description: `Asks which environment (${crypto.randomUUID()})`,
      overlap: 'skip',
    })) as { id: string };
    type Review = {
      id: string;
      runId: string;
      sessionId?: string;
      kind: string;
      prompt?: string;
    };
    let fire: Review | undefined;
    try {
      // The one fire's question is the one that carries this prompt, which only the fire's model
      // asks, so no question another case left open can be taken for it.
      await expect
        .poll(async () => {
          const listed = (await bureauCall(request, 'bureau.reviews.list', {})) as {
            reviews: Review[];
          };
          fire = listed.reviews.find(
            (candidate) =>
              candidate.kind === 'human-wait' && candidate.prompt === HUMAN_INPUT_PROMPT,
          );
          return fire?.id;
        })
        .toBeTruthy();
    } finally {
      // Whatever came of the poll, the schedule's cadence is moved out of reach, so no later fire
      // parks a second question for the cases that follow.
      const current = (await bureauCall(request, 'bureau.schedules.get', {
        scheduleId: schedule.id,
      })) as { revision: number };
      await bureauCall(request, 'bureau.schedules.update', {
        scheduleId: schedule.id,
        expectedRevision: current.revision,
        spec: '365d',
      });
    }
    if (fire === undefined) throw new Error('No fire parked on its question.');
    const question = fire;

    await page.goto(inboxAt(question));
    const row = rowOf(page, question);
    await expect(row).toContainText(HUMAN_INPUT_PROMPT);
    await paneOf(page).getByLabel('Your answer').fill('staging');
    await paneOf(page).getByRole('button', { name: 'Send', exact: true }).click();

    await expect(row).toHaveCount(0);
    // The run the wait belongs to goes on and finishes.
    await expect
      .poll(
        async () =>
          (
            (await bureauCall(request, 'bureau.tasks.get', {
              taskId: question.runId,
            })) as {
              status: string;
            }
          ).status,
      )
      .toBe('completed');
  });
});

test.describe('/reviews: a Bureau that fails', () => {
  for (const delivery of ['immediate', 'held'] as const) {
    test(`renders the Reviews failure with exactly two pending reads (${delivery})`, async ({
      page,
      checkA11y,
      pageErrors,
    }) => {
      const time = Date.parse('2026-11-10T15:00:00Z');
      await page.clock.install({ time: time - 1_000 });
      await page.clock.pauseAt(time);
      await holdBureauFeed(page);
      const release = Promise.withResolvers<void>();
      const counts = { waiting: 0, resolved: 0 };
      pageErrors.expect({
        pattern: loggedFailedResponse(500, /\/jsonrpc/),
        reason: 'the two pending reads and the independent resolved read receive a 500',
        count: 3,
      });
      await page.route('**/jsonrpc', async (route) => {
        const call = route.request().postDataJSON() as {
          method?: string;
          params?: { status?: string };
        };
        if (call.method !== 'bureau.reviews.list') return route.fallback();
        if (call.params?.status === 'resolved') counts.resolved += 1;
        else if (call.params?.status === undefined || call.params.status === 'pending') {
          counts.waiting += 1;
        } else return route.fallback();
        if (delivery === 'held') await release.promise;
        await route.fulfill({ status: 500, json: { error: 'The Bureau broke.' } });
      });

      try {
        await page.goto('/reviews');
        if (delivery === 'held') {
          await expect(page.getByRole('heading', { level: 1, name: 'Reviews' })).toBeVisible();
          await expect.poll(() => counts.waiting).toBeGreaterThanOrEqual(2);
        }
      } finally {
        release.resolve();
      }
      await expect(page.locator('[data-view="reviews"]')).toHaveAttribute('data-state', 'ready');
      await expect(
        page.getByRole('alert').filter({ hasText: 'Something went wrong' }),
      ).toBeVisible();
      await expect(page.getByText('Nothing waiting on you')).toHaveCount(0);
      await expect.poll(() => counts.resolved).toBeGreaterThanOrEqual(1);
      expect(counts).toEqual({ waiting: 2, resolved: 1 });
      // The fake clock stops animation frames; resume only after the exact read assertion so the
      // accessibility and capture helpers can observe a painted frame without driving a poll.
      await page.clock.resume();
      await checkA11y(`the inbox with the Bureau failing (${delivery})`);
      await captureForDesignReview(page, {
        route: '/reviews',
        state: `waiting list failed, ${delivery} response`,
        source: '31-reviews.spec.ts',
      });
    });
  }
});

/** What is waiting, as the two services say it: the Bureau's reviews and the engine's pending ones. */
async function waitingCount(request: APIRequestContext): Promise<number> {
  // The merged list already holds the engine's workflow reviews, which is what the count reads.
  const merged = (await bureauCall(request, 'bureau.reviews.list', {})) as {
    reviews: unknown[];
  };
  return merged.reviews.length;
}

/** The navigation's Reviews entry says exactly `count`, which is no number at all for none. */
const showsCount = (count: number) => new RegExp(`Reviews\\s*${count === 0 ? '' : count}$`);

test.describe('the count in the navigation', () => {
  test('is what is waiting across both services, and follows it with no reload', async ({
    page,
    request,
  }) => {
    const before = await waitingCount(request);
    await page.goto('/reviews');
    const link = page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('link', { name: /^Reviews/ });
    await expect(link).toHaveText(showsCount(before));

    await runToEnd(request, 'demo:tool-runner', newThreadId('reviews-count'), 'Refund order-1001');

    // The page asks again every five seconds, so a new approval shows without a reload.
    await expect(link).toHaveText(showsCount(before + 1));
  });
});

for (const width of WIDTHS) {
  test(`the inbox fits at ${width} pixels, and passes axe`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const threadId = newThreadId('reviews-width');
    await runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001');
    const review = await waitingReviewOf(request, threadId);

    await page.goto('/reviews');

    await expect(rowOf(page, review)).toBeVisible();
    const fits = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    expect(await fits()).toBeLessThanOrEqual(0);
    await checkA11y(`the inbox at ${width}px`);

    // Below 900 pixels one pane shows at a time, so the open review replaces the list.
    await page.goto(inboxAt(review));
    await expect(paneOf(page)).toBeVisible();
    expect(await fits()).toBeLessThanOrEqual(0);
    await checkA11y(`an open review at ${width}px`);
  });
}
