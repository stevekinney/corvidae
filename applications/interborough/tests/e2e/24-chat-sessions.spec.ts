/**
 * Starting, listing, and returning to chat sessions: `/` opens the newest chat, `/chats` lists them
 * with load-more paging, a session a goal or a schedule's fire started is in neither (its run on
 * `/runs` links to it), `/chats/new` starts one with the agent chosen above the composer and becomes
 * `/chats/:chat` without a reload, and a finished session opens on its whole transcript. The
 * page is the real application against the real host.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { TASK_COPY, VIEW_COPY } from '../../src/app/copy.ts';
import {
  conversation,
  deleteChats,
  newThreadId,
  releaseBarrier,
  runToEnd,
} from './chat-support.ts';
import { E2E_BUREAU_URL, E2E_DEFAULT_AGENT } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { expectEngineMissesForRuns } from './task-support.ts';

const composer = (page: Page) => page.getByRole('textbox');

/**
 * The New chat action of the empty Chat page. A fresh host also shows the first-run checklist,
 * whose last step links to /chats/new; the page's own action is the primary button.
 */
const newChatAction = (page: Page) =>
  page.getByRole('link', { name: 'New chat' }).and(page.locator('[data-cinder-variant="primary"]'));

// A new chat with no `?agent=` starts with the host's default agent, the barrier agent
// (`E2E_DEFAULT_AGENT`), which holds its run until the barrier is released. A spec that sends to it
// leaves that run held, and a later spec that counts the runs held would read it.
test.afterEach(async ({ request }) => {
  await releaseBarrier(request);
});

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

const sessionUrl = /\/chats\/(?!new(?:$|\?))[^/?]+$/;

/** The session identifier the address names. */
function sessionOf(page: Page): string {
  return decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '');
}

const SEEDED_GOAL_SESSION = 'goal-seeded-goal-s0';
const SEEDED_GOAL_RUN = 'goal-seeded-goal-a0';
const WIDTHS = [375, 1280] as const;

type Context = { id: string; origin: string };
type Fire = { id: string; contextId: string; status: string };

/** One call to the Bureau's management plane, as another client would make it. */
async function bureau<Result>(
  request: APIRequestContext,
  method: string,
  params: Record<string, unknown>,
): Promise<Result> {
  const response = await request.post('/bureau/jsonrpc', {
    data: { jsonrpc: '2.0', id: method, method, params },
  });
  const body = (await response.json()) as { result?: Result; error?: unknown };
  expect(body.error, method).toBeUndefined();
  return body.result as Result;
}

/**
 * A fresh host: its home holds the seed (an agent run on a schedule, and a goal that has already
 * run in a session of its own) and nothing a person did, so these cases run in order on it. The
 * second host is the one no case before them uses (`e2e-constants.ts`). What they make is deleted
 * afterwards, so a server reused between runs is fresh again.
 */
test.describe.serial('a fresh Interborough, and the sessions a goal and a schedule start', () => {
  test.use({ baseURL: E2E_BUREAU_URL });

  const made: string[] = [];
  let chatId = '';
  let fireContextId = '';
  let fireRunId = '';
  const fireInput = `e2e-fire-${crypto.randomUUID().slice(0, 8)}`;
  const chatTitle = `A chat I started ${crypto.randomUUID().slice(0, 8)}`;

  test.afterAll(async () => {
    await deleteChats(made, E2E_BUREAU_URL);
  });

  for (const width of WIDTHS) {
    test(`opens / on /chats with a welcome and a New chat link, not on the goal's session, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      // The goal has run, so its session exists and an empty chat list is the filter's doing.
      const every = await bureau<{ contexts: Context[] }>(request, 'bureau.contexts.list', {});
      expect(every.contexts.find((context) => context.id === SEEDED_GOAL_SESSION)?.origin).toBe(
        'goal',
      );
      await page.setViewportSize({ width, height: 900 });

      await page.goto('/');

      await expect(page).toHaveURL(/\/chats$/);
      const frame = page.locator('[data-view="chat"]');
      await expect(frame).toHaveAttribute('data-state', 'empty');
      await expect(frame.getByRole('heading', { level: 1 })).toHaveText(
        VIEW_COPY.chat.empty?.title ?? '',
      );
      await expect(newChatAction(page)).toBeVisible();
      // The welcome names the agents a chat can start with, each identifier in monospace.
      const agents = page.getByTestId('welcome-agents');
      await expect(agents).toContainText('Agents:');
      await expect(agents.locator('code.ib-identifier')).toHaveText([
        'demo:assistant',
        'demo:tool-runner',
        'demo:request-human-input',
        'demo:echo',
        'demo:model-switcher',
        'demo:internal',
      ]);
      await expect(agents.locator('code.ib-identifier').first()).toHaveCSS('font-family', /mono/i);
      await checkA11y(`chat — the welcome at ${width}px`);
    });
  }

  test('New chat reaches a working /chats/new, and the chat started there is listed and opened by /', async ({
    page,
  }) => {
    await page.goto('/chats');
    await newChatAction(page).click();
    await expect(page).toHaveURL(/\/chats\/new$/);

    await send(page, chatTitle);

    await expect(page).toHaveURL(sessionUrl);
    chatId = sessionOf(page);
    made.push(chatId);
    await expect(conversation(page).getByText('Hello from the assistant.')).toBeVisible();

    await page.goto('/chats');
    const rows = page.getByRole('region', { name: 'Chats' }).getByRole('listitem');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(chatTitle);
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`/chats/${chatId}$`));
  });

  test('a schedule’s fire makes a session that neither / nor /chats shows, though it is newer than the chat', async ({
    page,
    request,
  }) => {
    const created = await bureau<{ id: string }>(request, 'bureau.schedules.create', {
      agentName: 'demo:assistant',
      spec: '2s',
      input: fireInput,
      description: 'e2e fire for the chat list',
    });
    try {
      await expect
        .poll(
          async () => {
            const { tasks } = await bureau<{ tasks: Fire[] }>(request, 'bureau.tasks.list', {});
            const fire = tasks.find(
              (task) =>
                task.contextId.startsWith(`sched-${created.id}-`) && task.status === 'completed',
            );
            if (fire !== undefined) {
              fireRunId = fire.id;
              fireContextId = fire.contextId;
            }
            return fire !== undefined;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
    } finally {
      await bureau(request, 'bureau.schedules.cancel', { scheduleId: created.id });
    }
    made.push(fireContextId);

    const every = await bureau<{ contexts: Context[] }>(request, 'bureau.contexts.list', {});
    expect(every.contexts.find((context) => context.id === fireContextId)?.origin).toBe('schedule');
    // Newest first: the fire is above the chat, which is above the goal's session.
    const order = every.contexts.map((context) => context.id);
    expect(order.indexOf(fireContextId)).toBeLessThan(order.indexOf(chatId));
    expect(order.indexOf(chatId)).toBeLessThan(order.indexOf(SEEDED_GOAL_SESSION));

    await page.goto('/chats');
    const rows = page.getByRole('region', { name: 'Chats' }).getByRole('listitem');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(chatTitle);
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`/chats/${chatId}$`));
  });

  for (const width of WIDTHS) {
    test(`lists the goal’s run and the fire’s run on /runs, each with a link to its session, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/runs');

      const goalRow = page.locator(`tr[data-run="${SEEDED_GOAL_RUN}"]`);
      const fireRow = page.locator(`tr[data-run="${fireRunId}"]`);
      await expect(goalRow).toHaveCount(1);
      await expect(fireRow).toHaveCount(1);
      await expect(goalRow.locator(`a[href="/chats/${SEEDED_GOAL_SESSION}"]`)).toHaveCount(1);
      await expect(fireRow.locator(`a[href="/chats/${fireContextId}"]`)).toHaveCount(1);
      await expect(fireRow).toContainText(TASK_COPY.schedule);
      await checkA11y(`runs — a goal's and a schedule's runs at ${width}px`);
    });
  }

  test('opens the goal’s session from its run’s page, and the fire’s from its own', async ({
    page,
    pageErrors,
  }) => {
    expectEngineMissesForRuns(pageErrors);
    await page.goto(`/runs/${SEEDED_GOAL_RUN}`);
    await page.getByRole('link', { name: TASK_COPY.openSession }).click();
    await expect(page).toHaveURL(new RegExp(`/chats/${SEEDED_GOAL_SESSION}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Say hello.');

    await page.goto(`/runs/${fireRunId}`);
    await page.getByRole('link', { name: TASK_COPY.openSession }).click();
    await expect(page).toHaveURL(new RegExp(`/chats/${fireContextId}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(fireInput);
  });
});

test.describe('the home screen', () => {
  test('opens the chat that was updated most recently', async ({ page, request }) => {
    await runToEnd(request, 'demo:assistant', newThreadId('older'), 'An older chat');
    const newest = newThreadId('newest');
    await runToEnd(request, 'demo:assistant', newest, 'The newest chat');

    await page.goto('/');

    await expect(page).toHaveURL(new RegExp(`/chats/${newest}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('The newest chat');
  });

  test('replaces its own history entry, so Back does not return to it', async ({
    page,
    request,
  }) => {
    await runToEnd(request, 'demo:assistant', newThreadId('home'), 'Chat for the home screen');
    await page.goto('/agents');

    await page.goto('/');
    await expect(page).toHaveURL(sessionUrl);
    await page.goBack();

    await expect(page).toHaveURL(/\/agents$/);
  });
});

test.describe('the list of sessions, grouped', () => {
  const AWAITING_QUESTION = 'Which environment should the release go to?';

  for (const width of WIDTHS) {
    test(`lists a chat that waits on you under Needs you, above the rest, with its question and a chip, and a finished chat with its latest reply and no chip, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      const finished = newThreadId('finished');
      const waiting = newThreadId('waiting');
      const finishedTitle = `A finished chat ${crypto.randomUUID().slice(0, 8)}`;
      const waitingTitle = `A waiting chat ${crypto.randomUUID().slice(0, 8)}`;
      await runToEnd(request, 'demo:request-human-input', waiting, waitingTitle);
      await runToEnd(request, 'demo:assistant', finished, finishedTitle);
      await page.setViewportSize({ width, height: 900 });

      await page.goto('/chats');

      const list = page.getByRole('region', { name: 'Chats' });
      // Needs you comes first, and it holds the waiting chat and not the finished one.
      await expect(list.locator('[data-chat]').first()).toHaveAttribute('data-group', 'needs-you');
      const waitingRow = list.locator(`[data-group="needs-you"][data-chat="${waiting}"]`);
      await expect(waitingRow).toHaveCount(1);
      await expect(waitingRow).toContainText(waitingTitle);
      await expect(waitingRow).toContainText(AWAITING_QUESTION);
      await expect(waitingRow.locator('.cinder-badge')).toHaveText('Needs you');
      await expect(waitingRow.getByRole('time')).toHaveText(/now|ago/);
      // The finished chat is under Today, shows what the agent said last and not the title again,
      // and has no chip.
      const finishedRow = list.locator(`[data-group="today"][data-chat="${finished}"]`);
      await expect(finishedRow).toHaveCount(1);
      await expect(finishedRow).toContainText(finishedTitle);
      await expect(finishedRow).toContainText('Hello from the assistant.');
      await expect(finishedRow.locator('.cinder-badge')).toHaveCount(0);
      await expect(list.locator(`[data-chat="${finished}"]`)).toHaveCount(1);
      await expect(list.getByText('End of list')).toHaveCount(0);
      await expect(list.getByText('Agent:')).toHaveCount(0);
      // No view scrolls sideways.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await checkA11y(`the list of chats, grouped, at ${width}px`);
    });
  }
});

test.describe('the list of sessions', () => {
  test('is newest first, labelled with the agent, and pages with Load more', async ({
    page,
    request,
  }) => {
    const label = crypto.randomUUID().slice(0, 8);
    for (let index = 1; index <= 22; index += 1) {
      await runToEnd(
        request,
        'demo:assistant',
        newThreadId('page'),
        `${label} chat ${String(index).padStart(2, '0')}`,
      );
    }

    await page.goto('/chats');

    const list = page.getByRole('region', { name: 'Chats' });
    const rows = list.getByRole('listitem');
    // A chat waiting on someone is listed above the rest, so the newest is first in Today, and the
    // row names the agent.
    const today = list.locator('[data-group="today"]');
    await expect(today.first()).toContainText(`${label} chat 22`);
    await expect(today.first()).toContainText('demo:assistant');
    // A page is twenty rows. The list loads the next page as the end comes into view, or when
    // Load more is pressed, so keep asking for it until the oldest of these chats is there.
    const oldest = list.getByRole('button', { name: new RegExp(`${label} chat 01`) });
    await expect(async () => {
      const more = list.getByRole('button', { name: 'Load more' });
      if (await more.isVisible()) await more.click();
      await expect(oldest).toBeVisible({ timeout: 1_000 });
    }).toPass();
    expect(await rows.count()).toBeGreaterThan(20);
  });

  test('opens the session a row names', async ({ page, request }) => {
    const threadId = newThreadId('row');
    await runToEnd(request, 'demo:assistant', threadId, 'Open me from the list');
    await page.goto('/chats');

    await page
      .getByRole('region', { name: 'Chats' })
      .getByRole('button', { name: /Open me from the list/ })
      .click();

    await expect(page).toHaveURL(new RegExp(`/chats/${threadId}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Open me from the list');
  });
});

test.describe('a new chat', () => {
  test('talks to the default agent, which a searchable list changes before the first message', async ({
    page,
  }) => {
    await page.goto('/chats/new');
    const agent = page.getByRole('combobox', { name: 'Agent' });
    await expect(agent).toHaveValue(E2E_DEFAULT_AGENT);

    await agent.fill('tool');
    await page.getByRole('option', { name: /tool-runner/i }).click();

    await expect(page).toHaveURL(/\/chats\/new\?agent=demo(?::|%3A)tool-runner$/);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  });

  test('starts from ?agent=, becomes /chats/:chat without a reload, and fixes the agent', async ({
    page,
  }) => {
    await page.goto('/chats/new?agent=demo:tool-runner');
    await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveValue('tool-runner');
    // A reload would discard this.
    await page.evaluate(() => {
      Reflect.set(window, '__stillHere', true);
    });

    await send(page, 'Refund order-1001');

    await expect(page).toHaveURL(sessionUrl);
    await expect(page.locator('.ib-decision')).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, '__stillHere'))).toBe(true);
    await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveCount(0);
    await expect(
      page
        .getByRole('region', { name: 'Conversation' })
        .getByText('demo:tool-runner', { exact: true }),
    ).toHaveCount(1);
  });

  test('replaces its history entry when it starts, so Back returns to where the person came from', async ({
    page,
  }) => {
    await page.goto('/agents');
    await page.goto('/chats/new');

    await send(page, 'A chat for the back button');
    await expect(page).toHaveURL(sessionUrl);
    await page.goBack();

    await expect(page).toHaveURL(/\/agents$/);
  });

  test('is not found for an agent that does not exist', async ({ page }) => {
    await page.goto('/chats/new?agent=no-such-agent');
    const frame = page.locator('[data-view="chat"]');
    await expect(frame).toHaveAttribute('data-state', 'not-found');
    // It is the agent that is missing, so the page says so and not that a conversation is.
    await expect(frame.getByRole('heading', { level: 1 })).toHaveText(
      VIEW_COPY.chat.notFoundByPattern?.['/chats/new']?.title ?? '',
    );
  });

  test('stays on /chats/new with the row failed and a retry when the first run is refused', async ({
    page,
  }) => {
    let refuse = true;
    await page.route('**/ag-ui/agents/demo*assistant/run', async (route) => {
      if (!refuse) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: `data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'The thread is busy.', code: 'THREAD_BUSY' })}\n\n`,
      });
    });
    await page.goto('/chats/new?agent=demo:assistant');

    await send(page, 'A first message that is refused');

    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page).toHaveURL(/\/chats\/new\?agent=demo(?::|%3A)assistant$/);
    refuse = false;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page).toHaveURL(sessionUrl);
    await expect(conversation(page).getByText('Hello from the assistant.')).toBeVisible();
  });
});

test.describe('returning to a session', () => {
  test('a second chat with the same agent does not replace the first: it opens with its own identifier and title', async ({
    page,
  }) => {
    const label = crypto.randomUUID().slice(0, 8);
    await page.goto('/chats/new?agent=demo:assistant');
    await send(page, `${label} first topic`);
    await expect(page).toHaveURL(sessionUrl);
    const first = sessionOf(page);
    await expect(conversation(page).getByText('Hello from the assistant.')).toBeVisible();

    await page.goto('/chats/new?agent=demo:assistant');
    await send(page, `${label} second topic`);
    await expect(page).toHaveURL(sessionUrl);
    const second = sessionOf(page);
    await expect(conversation(page).getByText('Hello from the assistant.')).toBeVisible();
    expect(second).not.toBe(first);

    await page.goto('/chats');
    await page
      .getByRole('region', { name: 'Chats' })
      .getByRole('button', { name: new RegExp(`${label} first topic`) })
      .click();

    expect(sessionOf(page)).toBe(first);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${label} first topic`);
  });

  /**
   * A new chat taken through two questions, so its transcript has a first and a second turn. The
   * first question is unique to the session, so a list of every session names this one alone.
   */
  async function finishedSession(page: Page): Promise<{ address: string; first: string }> {
    const first = `Question one ${crypto.randomUUID().slice(0, 8)}`;
    await page.goto('/chats/new?agent=demo:assistant');
    await send(page, first);
    await expect(page).toHaveURL(sessionUrl);
    await expect(conversation(page).getByText('Hello from the assistant.')).toHaveCount(1);
    await send(page, 'Question two');
    await expect(conversation(page).getByText('Hello from the assistant.')).toHaveCount(2);
    return { address: page.url(), first };
  }

  /** That the transcript on screen is the whole thread, in the order it happened. */
  async function expectWholeTranscript(page: Page, first: string): Promise<void> {
    await expect(page.getByRole('log').getByText(first)).toBeVisible();
    await expect(conversation(page).getByText('Hello from the assistant.')).toHaveCount(2);
    const content = (await page.locator('[data-session]').textContent()) ?? '';
    const positions = [first, 'Hello from the assistant.', 'Question two'].map((text) =>
      content.indexOf(text),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((left, right) => left - right));
    expect(content.lastIndexOf('Hello from the assistant.')).toBeGreaterThan(
      content.indexOf('Question two'),
    );
  }

  test('a finished session opens on its whole transcript, in order, after a reload and after navigating away and back', async ({
    page,
  }) => {
    const { address, first } = await finishedSession(page);

    await page.reload();
    await expectWholeTranscript(page, first);

    await page.goto('/runs');
    await page.goto(address);
    await expectWholeTranscript(page, first);
  });

  test('a finished session opens on its whole transcript when the person leaves it inside the app and comes back', async ({
    page,
  }) => {
    const { address, first } = await finishedSession(page);

    // A link and Back, and a list row: no reload, so nothing of the page is carried but the app.
    await page.getByRole('link', { name: 'Agents', exact: true }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await page.goBack();
    await expect(page).toHaveURL(address);
    await expectWholeTranscript(page, first);

    await page.getByRole('link', { name: 'Agents', exact: true }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await page.getByRole('link', { name: 'Chat', exact: true }).first().click();
    await page
      .getByRole('region', { name: 'Chats' })
      .getByRole('button', { name: new RegExp(first) })
      .click();
    await expect(page).toHaveURL(address);
    await expectWholeTranscript(page, first);
  });
});
