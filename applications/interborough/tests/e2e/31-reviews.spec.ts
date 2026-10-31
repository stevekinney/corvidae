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
import { conversation, newThreadId, runToEnd } from './chat-support.ts';
import { E2E_BASE_URL } from './e2e-constants.ts';
import { expect, holdBureauFeed, loggedFailedResponse, test } from './fixtures.ts';
import {
  bureauCall,
  taskOfSession,
  threadMessages,
  waitingReviewOf,
  type WaitingReview,
} from './task-support.ts';

const WIDTHS = [375, 1280] as const;

// Wide enough that the list and the open review show side by side (ListDetail shows one pane at a
// time below 900 pixels of its own width), so a row is on the page while its review is open.
test.use({ viewport: { width: 1600, height: 900 } });

const composer = (page: Page) => page.getByRole('textbox');

async function send(page: Page, text: string): Promise<void> {
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
    if (outgoing.method() !== 'POST' || !outgoing.url().includes('/bureau/jsonrpc')) return;
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

/** The open review's pane. */
const paneOf = (page: Page) => page.locator('.ib-review-pane');

/** Whether a tool result in a conversation carries `refundedCents`, which only a refund that ran does. */
function refundRan(messages: unknown[]): boolean {
  return JSON.stringify(messages).includes('refundedCents');
}

/** Starts a refund run that waits on its approval, and opens the inbox on it. */
async function waitingRefund(
  page: Page,
  request: APIRequestContext,
  name: string,
): Promise<{ threadId: string; review: WaitingReview }> {
  const threadId = newThreadId(name);
  await runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001');
  expect(refundRan(await threadMessages(request, threadId))).toBe(false);
  const review = await waitingReviewOf(request, threadId);
  await page.goto(inboxAt(review));
  await expect(paneOf(page)).toContainText('Refund order order-1001 for $42.00?');
  return { threadId, review };
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
    // The list is the question itself, longest waiting first; nothing is open until a row is.
    await expect(rowOf(page, review)).toContainText('Refund order order-1001 for $42.00?');
    await expect(paneOf(page)).toHaveCount(0);
    await rowOf(page, review).click();

    // The pane says what is asked, who asked it, and what the call was given, and where from.
    await expect(paneOf(page)).toContainText('Refund order order-1001 for $42.00?');
    const source = paneOf(page).getByTestId('review-source');
    await expect(source).toContainText('Asked by');
    await expect(source.getByRole('link', { name: 'demo:tool-runner' })).toBeVisible();
    await expect(source).toContainText('waiting since');
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
    await paneOf(page).getByLabel('Note to the agent (optional)').fill('Wrong customer.');
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
    const note = paneOf(page).getByLabel('Note to the agent (optional)');
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
    await paneOf(page).getByLabel('Note to the agent (optional)').fill('Not this one.');
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

  test('Allow for the rest of this chat approves the tool and sends remember', async ({
    page,
    request,
  }) => {
    const { threadId, review } = await waitingRefund(page, request, 'reviews-remember');
    const resolves = recordResolves(page);
    await paneOf(page).getByRole('button', { name: 'Allow for the rest of this chat' }).click();

    await expect(rowOf(page, review)).toHaveCount(0);
    expect(resolves[0]).toMatchObject({ id: review.id, decision: 'approve', remember: true });
    await expect.poll(async () => refundRan(await threadMessages(request, threadId))).toBe(true);
  });

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
    await page.locator('.ib-decision').getByRole('button', { name: 'Approve' }).click();
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
    await expect(page.locator('.ib-decision')).toHaveCount(0);
    // The refund shows as a tool call that succeeded, with its result under Details.
    await expect(page.getByText('Used 2 tools')).toBeVisible();
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(page.getByText('issue-refund').first()).toBeVisible();
    await page.getByRole('button', { name: 'Details' }).last().click();
    await expect(page.locator('dt', { hasText: 'Result: refundedCents' })).toBeVisible();
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
    await expect(page.locator('.ib-decision')).toContainText('Refund order order-1001 for $42.00?');

    const inbox = await context.newPage();
    await inbox.goto(inboxAt(review));
    await paneOf(inbox).getByRole('button', { name: 'Approve' }).click();
    await expect(rowOf(inbox, review)).toHaveCount(0);

    // The page that was already open reads the decision within five seconds.
    await expect(page.locator('.ib-decision')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByText('1 run is waiting on you')).toHaveCount(0, { timeout: 5_000 });
  });

  test('is listed under Done once it is decided, with who decided it, and cannot be decided again', async ({
    page,
    request,
  }) => {
    const { review } = await waitingRefund(page, request, 'reviews-done');
    await paneOf(page).getByRole('button', { name: 'Approve' }).click();
    await expect(rowOf(page, review)).toHaveCount(0);

    await page.goto(inboxAt(review, 'done'));
    await expect(rowOf(page, review)).toContainText('Approved');
    await expect(paneOf(page).getByTestId('review-resolution')).toContainText('Approved');
    await expect(paneOf(page).getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(paneOf(page).getByRole('button', { name: 'Deny' })).toHaveCount(0);
    // Done is read through the same list, asked for what was resolved.
    await page.getByRole('tab', { name: /^Waiting/ }).click();
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
    await expect(page.locator('.ib-decision')).toBeVisible();
    const threadId = await sessionOf(page);
    const review = await waitingReviewOf(request, threadId);

    const inbox = await context.newPage();
    await inbox.goto(inboxAt(review));
    await paneOf(inbox).getByRole('button', { name: 'Approve' }).click();
    await expect(rowOf(inbox, review)).toHaveCount(0);

    await expect(page.locator('.ib-decision')).toHaveCount(0, { timeout: 5_000 });
  });

  test('settles a question in a chat that never reloaded: it is gone, the next message is a normal turn, and a second question is settled the same way', async ({
    page,
    request,
    context,
  }) => {
    const starts = recordStarts(page);
    const asked = page.getByRole('alert').filter({ hasText: HUMAN_INPUT_PROMPT });
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
    await expect(asked).toHaveCount(0, { timeout: 5_000 });

    // The question is settled, so this is a message and not its answer: no resume, no refusal.
    await send(page, 'Another one');
    await expect(asked).toBeVisible();
    const last = starts.at(-1);
    expect(last?.resume ?? []).toEqual([]);
    expect(JSON.stringify(last?.messages)).toContain('Another one');
    await expect(page.getByText(/was not found/)).toHaveCount(0);

    // The second question is settled elsewhere too, and the chat reads it again.
    await answer('production');
    await expect(asked).toHaveCount(0, { timeout: 5_000 });
  });
});

test.describe('a question a run asks', () => {
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
      'Asked by demo:request-human-input',
    );
    await expect(paneOf(page)).toContainText('The agent continues with your answer.');
    await checkA11y('a question in the inbox');
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

test.describe('a Bureau that fails', () => {
  test('says so with a banner on a page that is up, and does not claim nothing is waiting', async ({
    page,
    checkA11y,
    pageErrors,
  }) => {
    pageErrors.expect({
      pattern: loggedFailedResponse(500, /bureau\/jsonrpc/),
      reason: 'the test answers the Bureau’s review list with a 500',
      count: 3,
    });
    // The feed's catch-up would ask the lists again while the page is open, so it is held.
    await holdBureauFeed(page);
    await page.route('**/bureau/jsonrpc', async (route) => {
      if ((route.request().postData() ?? '').includes('"bureau.reviews.list"')) {
        await route.fulfill({ status: 500, json: { error: 'The Bureau broke.' } });
        return;
      }
      await route.fallback();
    });

    await page.goto('/reviews');

    await expect(page.locator('[data-view="reviews"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('alert').filter({ hasText: 'Something went wrong' })).toBeVisible();
    await expect(page.getByText('All caught up')).toHaveCount(0);
    await checkA11y('the inbox with the Bureau failing');
  });
});

/** What is waiting, as the two services say it: the Bureau's reviews and the engine's pending ones. */
async function waitingCount(request: APIRequestContext): Promise<number> {
  const bureau = (await bureauCall(request, 'bureau.reviews.list', {})) as {
    reviews: unknown[];
  };
  const engine = await request.get(`${E2E_BASE_URL}/v1/reviews`, {
    params: { status: 'pending' },
  });
  return bureau.reviews.length + ((await engine.json()) as { items: unknown[] }).items.length;
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
    await expect(link).toHaveText(showsCount(before + 1), { timeout: 15_000 });
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
