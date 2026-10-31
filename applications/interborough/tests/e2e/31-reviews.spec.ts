/**
 * `/reviews` against the real host: a to-do list of the Bureau's tool approvals and questions, each
 * its own sentence with its decision inline, followed by the engine's reviews when it has any.
 * Approving `tool-runner`'s review runs its tool; a chat that is already open agrees about an
 * approval whichever one decides it, within a few seconds and with no reload; and a question is
 * answered with one text field. Sessions are started through the AG-UI mount, the way a client other
 * than the page would.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { HUMAN_INPUT_PROMPT } from '../../src/host/seed.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { E2E_BASE_URL } from './e2e-constants.ts';
import { expect, holdBureauFeed, loggedFailedResponse, test } from './fixtures.ts';
import { bureauCall, taskOfSession, threadMessages } from './task-support.ts';

const WIDTHS = [375, 1280] as const;

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

/** The Bureau's row for a session's review: the one list item that links to that session's chat. */
const rowOfSession = (page: Page, threadId: string) =>
  page.locator('.ib-review').filter({
    has: page.locator(`a[href="/chats/${threadId}"]`),
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
    // The item is the question itself, with the order and the amount, and says where it came from.
    await expect(row).toContainText('Refund order order-1001 for $42.00?');
    await expect(row).toContainText('tool-runner');
    await expect(row).toContainText('Refund order-1001');
    // No raw policy string, no state tabs, and no Live toggle for an engine with no reviews.
    await expect(page.getByText(/requires approval/)).toHaveCount(0);
    await expect(page.getByText('Decided', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Timed out', { exact: true })).toHaveCount(0);
    await expect(page.locator('main').getByLabel('Live', { exact: true })).toHaveCount(0);
    await checkA11y('a tool approval in the inbox');
    await row.getByRole('button', { name: 'Approve' }).click();

    await expect(row).toHaveCount(0);
    // The row going is not the evidence: the tool ran, and its result is in the conversation.
    await expect.poll(async () => refundRan(await threadMessages(request, threadId))).toBe(true);
  });

  test('denied from the inbox with a note never runs the tool', async ({ page, request }) => {
    const threadId = newThreadId('reviews-reject');
    await runToEnd(request, 'tool-runner', threadId, 'Refund order-1001');

    await page.goto('/reviews');
    const row = rowOfSession(page, threadId);
    await row.getByLabel('Note to the agent (optional)').fill('Wrong customer.');
    await row.getByRole('button', { name: 'Deny' }).click();

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

    await page.goto(`/chats/${threadId}`);
    await page.locator('.ib-decision').getByRole('button', { name: 'Approve' }).click();
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
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(row).toHaveCount(0);

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
    await runToEnd(request, 'tool-runner', threadId, 'Refund order-1001');
    await page.goto(`/chats/${threadId}`);
    await expect(page.locator('.ib-decision')).toContainText('Refund order order-1001 for $42.00?');

    const inbox = await context.newPage();
    await inbox.goto('/reviews');
    await rowOfSession(inbox, threadId).getByRole('button', { name: 'Approve' }).click();
    await expect(rowOfSession(inbox, threadId)).toHaveCount(0);

    // The page that was already open reads the decision within five seconds.
    await expect(page.locator('.ib-decision')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByText('1 run is waiting on you')).toHaveCount(0, { timeout: 5_000 });
  });
});

test.describe('a decision made in the inbox', () => {
  test('reaches the chat tab that started the run, which was never reloaded', async ({
    page,
    context,
  }) => {
    // The run is started from this page, not found waiting: its first read of the pending reviews
    // can be the shared, cached one that predates the review, and must not take the call as decided.
    await page.goto('/chats/new?agent=tool-runner');
    await send(page, 'Refund order 1234');
    await expect(page.locator('.ib-decision')).toBeVisible();
    const threadId = await sessionOf(page);

    const inbox = await context.newPage();
    await inbox.goto('/reviews');
    await rowOfSession(inbox, threadId).getByRole('button', { name: 'Approve' }).click();
    await expect(rowOfSession(inbox, threadId)).toHaveCount(0);

    await expect(page.locator('.ib-decision')).toHaveCount(0, { timeout: 5_000 });
  });

  test('settles a question in a chat that never reloaded: it is gone, the next message is a normal turn, and a second question is settled the same way', async ({
    page,
    context,
  }) => {
    const starts = recordStarts(page);
    const asked = page.getByRole('alert').filter({ hasText: HUMAN_INPUT_PROMPT });
    await page.goto('/chats/new?agent=request-human-input');
    await send(page, 'Release it');
    await expect(asked).toBeVisible();
    const threadId = await sessionOf(page);

    const inbox = await context.newPage();
    await inbox.goto('/reviews');
    const answer = async (text: string) => {
      const row = rowOfSession(inbox, threadId);
      await row.getByLabel('Your answer').fill(text);
      await row.getByRole('button', { name: 'Send answer' }).click();
      await expect(row).toHaveCount(0);
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
    await inbox.reload();
    await answer('production');
    await expect(asked).toHaveCount(0, { timeout: 5_000 });
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
    await expect(row).toContainText(
      'request-human-input asks: Which environment should the release go to?',
    );
    await expect(row).toContainText('The agent continues with your answer.');
    await checkA11y('a question in the inbox');
    await row.getByLabel('Your answer').fill('staging');
    await row.getByRole('button', { name: 'Send answer' }).click();

    await expect(row).toHaveCount(0);
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
  });
});

test.describe('a scheduled run’s human wait', () => {
  test('answered in the inbox lets that run continue', async ({ page, request }) => {
    // A schedule whose agent asks a question. A fire that is still going is not fired over
    // (`overlap: 'skip'`), so the first fire is the only one while its question is open.
    const schedule = (await bureauCall(request, 'bureau.schedules.create', {
      agentName: 'request-human-input',
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

    await page.goto('/reviews');
    const row = page.locator('.ib-review').filter({
      has: page.locator(
        question.sessionId === undefined
          ? `a[href="/runs/${question.runId}"]`
          : `a[href="/chats/${question.sessionId}"]`,
      ),
    });
    await expect(row).toContainText(HUMAN_INPUT_PROMPT);
    await row.getByLabel('Your answer').fill('staging');
    await row.getByRole('button', { name: 'Send answer' }).click();

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
  test('leaves the engine’s reviews on the page, with the Bureau’s own banner beside them', async ({
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
    // The engine's seeded reviews are still listed beside it, in their own section.
    await expect(page.getByRole('heading', { level: 2, name: 'Workflow reviews' })).toBeVisible();
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

    await runToEnd(request, 'tool-runner', newThreadId('reviews-count'), 'Refund order-1001');

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
    await runToEnd(request, 'tool-runner', newThreadId('reviews-width'), 'Refund order-1001');

    await page.goto('/reviews');

    await expect(page.locator('.ib-review').first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await checkA11y(`the inbox at ${width}px`);
  });
}
