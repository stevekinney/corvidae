/**
 * Runs at `/runs` and `/runs/:run` against the real host, in the words of a task: the list says which
 * agent ran and what started it, and a run's page shows its answer, answers a question it waits on
 * with one text field, follows the run's stream across a dropped connection and across a reload,
 * resuming from the last cursor each time, and cancels it after a confirmation, showing where its
 * cleanup stands. The sessions are
 * started through the AG-UI mount, the way a client other than the page would, and the runs that
 * must still be going when Playwright acts are held on the barrier (`barrier-agent.ts`).
 */
import type { BrowserContext, Page } from '@playwright/test';

import { TASK_COPY } from '../../src/app/copy.ts';
import { taskCursorKey } from '../../src/routes/workflows/runs/task-follower.svelte.ts';
import { expectWaiting, newThreadId, releaseBarrier, runToEnd, startRun } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { bureauCall, taskOfSession } from './task-support.ts';

const WIDTHS = [375, 1280] as const;
const ASSISTANT_REPLY = 'Hello from the assistant.';
const HUMAN_INPUT_THANKS = 'Thanks, the release will go to the environment you named.';

/** The cursor the page kept for a task, or `null` before it has kept one. */
async function keptCursor(page: Page, taskId: string): Promise<string | null> {
  return page.evaluate((key) => {
    const text = window.sessionStorage.getItem(key);
    return text === null ? null : (JSON.parse(text) as { cursor: string }).cursor;
  }, taskCursorKey(taskId));
}

/**
 * Lets the test cut the task streams the page has open. Chromium's offline emulation refuses new
 * requests but leaves a stream that is already open running, so the drop is two things together:
 * the open stream is severed the way a lost connection ends one (its reader fails), and the
 * network is then taken away so no reconnect can succeed until it is given back.
 */
async function makeStreamsSeverable(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const severs = new Set<() => void>();
    // `typeof fetch` carries Bun's `preconnect`, which a browser's does not have.
    const severable = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await originalFetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('bureau.tasks.events') || response.body === null) return response;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          severs.add(() => controller.error(new TypeError('network error')));
          void (async () => {
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) {
                  controller.close();
                  return;
                }
                controller.enqueue(chunk.value);
              }
            } catch (error) {
              try {
                controller.error(error);
              } catch {
                // The stream was already severed.
              }
            }
          })();
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    window.fetch = Object.assign(severable, { preconnect: window.fetch.preconnect });
    Object.defineProperty(window, '__severTaskStreams', {
      value: () => {
        for (const sever of severs) sever();
        severs.clear();
      },
    });
  });
}

/** Drops the network: the open streams fail, and nothing can connect until it is restored. */
async function dropNetwork(page: Page, context: BrowserContext): Promise<void> {
  await context.setOffline(true);
  await page.evaluate(() => {
    (window as unknown as { __severTaskStreams: () => void }).__severTaskStreams();
  });
}

/** A run left going on the barrier, and the task it is. */
async function runningBarrierTask(
  request: Parameters<typeof runToEnd>[0],
  label: string,
): Promise<{ threadId: string; taskId: string; abort: () => void }> {
  const threadId = newThreadId(label);
  const held = await startRun('barrier', threadId, 'Start the work');
  await expectWaiting(request, 1);
  const task = await taskOfSession(request, threadId);
  return { threadId, taskId: task.id, abort: () => held.abort() };
}

const heading = (page: Page) => page.locator('.ib-run__heading');

test.describe('the runs of a chat', () => {
  test('are listed with their agent, their chat, and their status, and a row opens the run with its answer', async ({
    page,
    request,
    checkA11y,
  }) => {
    const threadId = newThreadId('runs-link');
    await runToEnd(request, 'assistant', threadId, 'Say hello');
    const task = await taskOfSession(request, threadId);

    await page.goto('/runs');
    const row = page.locator(`[data-run="${task.id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'Done');
    await expect(row.getByRole('link', { name: 'Say hello' })).toHaveAttribute(
      'href',
      `/chats/${threadId}`,
    );
    await checkA11y('the runs list');
    await row.getByRole('link', { name: 'assistant' }).click();

    await expect(page).toHaveURL(new RegExp(`/runs/${task.id}$`));
    await expect(page.locator('[data-view="runs"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('assistant');
    await expect(heading(page).getByText('Done', { exact: true })).toBeVisible();
    // Open chat is the first action, and the answer is the stream's: the task view has none.
    await expect(page.getByRole('link', { name: 'Open chat' })).toHaveAttribute(
      'href',
      `/chats/${threadId}`,
    );
    await expect(page.getByRole('heading', { level: 2, name: 'Answer' })).toBeVisible();
    await expect(page.getByText(ASSISTANT_REPLY)).toBeVisible();
    // What only an operator uses is on the Engine tab, and not on this one.
    await expect(page.getByRole('button', { name: /Restart|Send signal|Send update/ })).toHaveCount(
      0,
    );
    await checkA11y('a completed run');
  });

  test('narrow by what started them, and the retired Tasks addresses are not routes', async ({
    page,
    request,
  }) => {
    const threadId = newThreadId('runs-list');
    await runToEnd(request, 'assistant', threadId, 'Say hello');
    const task = await taskOfSession(request, threadId);

    await page.goto('/runs?startedBy=chat');
    await expect(page.locator(`[data-run="${task.id}"]`)).toBeVisible();
    await expect(page.locator('[data-run^="goal-"]')).toHaveCount(0);

    // Pre-release, an old address has no redirect: `/tasks` is no route, and the outlet says so.
    await page.goto('/tasks');
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.locator('[data-run]')).toHaveCount(0);
    await page.goto(`/tasks/${task.id}`);
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
    await expect(page.locator('[data-run]')).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: /Tasks/ }),
    ).toHaveCount(0);
  });
});

test.describe('the runs of a caller who may not read the engine', () => {
  test('are the Bureau’s: the list and a run’s page are there, the Engine tab is not, and the engine-only views say so', async ({
    page,
    request,
  }) => {
    const threadId = newThreadId('runs-no-engine');
    await runToEnd(request, 'assistant', threadId, 'Say hello');
    const task = await taskOfSession(request, threadId);
    // The principal holds a scope, but not `workflows:read`.
    const scopes = ['system:read'];
    await page.route('**/api/v1/principal', async (route) => {
      await route.fulfill({ json: { method: 'api-key', subject: 'anonymous:local', scopes } });
    });
    await page.route('**/jsonrpc', async (route) => {
      const body = route.request().postData() ?? '';
      if (body.includes('"weft.system.principal"')) {
        await route.fulfill({
          json: {
            jsonrpc: '2.0',
            id: JSON.parse(body).id,
            result: { method: 'api-key', subject: 'anonymous:local', scopes },
          },
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/runs');
    await expect(page.locator('[data-view="runs"]')).toHaveAttribute('data-state', 'ready');
    const row = page.locator(`[data-run="${task.id}"]`);
    await expect(row).toBeVisible();
    await row.getByRole('link', { name: 'assistant' }).click();

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('assistant');
    await expect(page.getByText(ASSISTANT_REPLY)).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Summary' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Engine' })).toHaveCount(0);

    await page.goto('/runs?view=start');
    await expect(page.getByRole('heading', { level: 1, name: 'Runs are locked' })).toBeVisible();
    await expect(page.getByText('Requires workflows:read')).toBeVisible();
  });
});

test.describe('a run that waits on a question', () => {
  test('is answered with one text field, and the task goes on', async ({
    page,
    request,
    checkA11y,
  }) => {
    const threadId = newThreadId('tasks-human');
    await runToEnd(request, 'request-human-input', threadId, 'Release it');
    const task = await taskOfSession(request, threadId);
    expect(task.status).toBe('input-required');

    await page.goto(`/runs/${task.id}`);

    await expect(heading(page).getByText('Needs you', { exact: true })).toBeVisible();
    await expect(page.getByText('Which environment should the release go to?')).toBeVisible();
    await checkA11y('a run waiting on a question');
    await page.getByLabel('Your answer').fill('staging');
    await page.getByRole('button', { name: 'Send answer' }).click();

    // The page reads the task again, and the stream carries what the run answers.
    await expect(heading(page).getByText('Done', { exact: true })).toBeVisible();
    await expect(page.getByText(HUMAN_INPUT_THANKS)).toBeVisible();
    await expect(page.getByLabel('Your answer')).toHaveCount(0);
  });
});

test.describe('following a task', () => {
  test('resumes from the last cursor after the network drops, and from the kept one after a reload', async ({
    page,
    context,
    request,
  }) => {
    await makeStreamsSeverable(page);
    // A run parked on a question has made one durable change, so the stream has a position to keep.
    const threadId = newThreadId('tasks-follow');
    await runToEnd(request, 'request-human-input', threadId, 'Release it');
    const { id: taskId } = await taskOfSession(request, threadId);
    const resumes: Array<string | undefined> = [];
    page.on('request', (outgoing) => {
      if (outgoing.url().includes('/bureau/v1/subscriptions/bureau.tasks.events')) {
        resumes.push(outgoing.headers()['last-event-id']);
      }
    });

    await page.goto(`/runs/${taskId}`);
    await expect(page.getByText('Which environment should the release go to?')).toBeVisible();
    // The first stream has no position to resume from, and it gives the page one.
    expect(resumes).toEqual([undefined]);
    await expect.poll(() => keptCursor(page, taskId)).not.toBeNull();
    const before = await keptCursor(page, taskId);

    // The connection drops, and the answer arrives while the page cannot hear it.
    await dropNetwork(page, context);
    await expect(page.getByText(TASK_COPY.followReconnecting)).toBeVisible();
    await bureauCall(request, 'bureau.tasks.respond', {
      taskId,
      messageId: `answer-${crypto.randomUUID()}`,
      answer: 'staging',
      signalName: 'environment',
    });
    await expect
      .poll(
        async () =>
          ((await bureauCall(request, 'bureau.tasks.get', { taskId })) as { status: string })
            .status,
      )
      .toBe('completed');

    // With the network back, the stream resumes from the position the page had, and carries on.
    await context.setOffline(false);
    await expect(heading(page).getByText('Done', { exact: true })).toBeVisible();
    await expect(page.getByText(HUMAN_INPUT_THANKS)).toBeVisible();
    expect(resumes.at(-1)).toBe(before);
    const after = await keptCursor(page, taskId);
    expect(after).not.toBe(before);

    // After a full reload the page resumes from the cursor it kept, and still has the answer, which
    // a stream resumed from a position does not send again.
    resumes.length = 0;
    await page.reload();
    await expect(heading(page).getByText('Done', { exact: true })).toBeVisible();
    await expect(page.getByText(HUMAN_INPUT_THANKS)).toBeVisible();
    await expect.poll(() => resumes.length).toBeGreaterThanOrEqual(1);
    expect(resumes[0]).toBe(after);
  });
});

test.describe('cancelling a run', () => {
  test('shows the cancellation until its cleanup is done, and then says it is cleaned up', async ({
    page,
    request,
    checkA11y,
  }) => {
    const { taskId, abort } = await runningBarrierTask(request, 'tasks-cancel');
    try {
      await page.goto(`/runs/${taskId}`);
      await expect(heading(page).getByText('Working', { exact: true })).toBeVisible();
      await checkA11y('a run that can be cancelled');

      await page.getByRole('button', { name: 'Cancel run' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel run' }).click();

      await expect(page.getByText(TASK_COPY.cancel['cleaned-up'])).toBeVisible();
      await expect(heading(page).getByText('Canceled', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
      await checkA11y('a run that was cleaned up');
    } finally {
      abort();
      await releaseBarrier(request);
    }
  });
});

for (const width of WIDTHS) {
  test(`a run’s page fits at ${width} pixels, and passes axe`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const threadId = newThreadId('tasks-width');
    await runToEnd(request, 'request-human-input', threadId, 'Release it');
    const task = await taskOfSession(request, threadId);

    await page.goto(`/runs/${task.id}`);

    await expect(page.getByLabel('Your answer')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await checkA11y(`a run waiting on a question at ${width}px`);
  });
}
