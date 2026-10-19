/**
 * Tasks at `/tasks` and `/tasks/:id` against the real host: a chat session lists its tasks and each
 * links to its page; a task that waits on a question is answered with one text field and goes on;
 * the page follows a task's stream across a dropped connection and across a reload, resuming from
 * the last cursor each time; and cancelling a task shows where its cleanup stands. The sessions are
 * started through the AG-UI mount, the way a client other than the page would, and the runs that
 * must still be going when Playwright acts are held on the barrier (`barrier-agent.ts`).
 */
import type { Page } from '@playwright/test';

import { TASK_COPY } from '../../src/app/copy.ts';
import { taskCursorKey } from '../../src/routes/tasks/task-follower.svelte.ts';
import {
  expectWaiting,
  newThreadId,
  releaseBarrier,
  runToEnd,
  startRun,
} from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { bureauCall, taskOfSession } from './task-support.ts';

const WIDTHS = [375, 1280] as const;
const ASSISTANT_REPLY = 'Hello from the assistant.';
const HUMAN_INPUT_THANKS = 'Thanks, the release will go to the environment you named.';
const BARRIER_REPLY = 'The barrier opened.';

/** The cursor the page kept for a task, or `null` before it has kept one. */
async function keptCursor(page: Page, taskId: string): Promise<string | null> {
  return page.evaluate((key) => {
    const text = window.sessionStorage.getItem(key);
    return text === null ? null : (JSON.parse(text) as { cursor: string }).cursor;
  }, taskCursorKey(taskId));
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

test.describe('a chat session’s tasks', () => {
  test('are listed in the session, and following one opens its page with the answer', async ({
    page,
    request,
    checkA11y,
  }) => {
    const threadId = newThreadId('tasks-link');
    await runToEnd(request, 'assistant', threadId, 'Say hello');
    const task = await taskOfSession(request, threadId);

    await page.goto(`/chat/${threadId}`);
    const tasks = page.getByRole('region', { name: 'Tasks in this chat' });
    await expect(tasks).toBeVisible();
    await tasks.getByRole('link').first().click();

    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
    await expect(page.locator('[data-view="tasks"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('assistant task');
    await expect(page.getByText('Completed', { exact: true })).toBeVisible();
    // The answer is the stream's: the task view the Bureau serves has none.
    await expect(page.getByRole('heading', { level: 2, name: 'Answer' })).toBeVisible();
    await expect(page.getByText(ASSISTANT_REPLY)).toBeVisible();
    await expect(page.getByText(/history/i)).toHaveCount(0);
    await checkA11y('a completed task');
  });

  test('are the list at /tasks, narrowed by session, and /tasks stays out of the navigation', async ({
    page,
    request,
  }) => {
    const threadId = newThreadId('tasks-list');
    await runToEnd(request, 'assistant', threadId, 'Say hello');
    const task = await taskOfSession(request, threadId);

    await page.goto(`/tasks?session=${threadId}`);

    await expect(page.getByRole('row')).toHaveCount(2);
    await expect(page.locator(`a[href="/tasks/${task.id}"]`)).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: /^Tasks/ }),
    ).toHaveCount(0);
  });
});

test.describe('a task that waits on a question', () => {
  test('is answered with one text field, and the task goes on', async ({
    page,
    request,
    checkA11y,
  }) => {
    const threadId = newThreadId('tasks-human');
    await runToEnd(request, 'request-human-input', threadId, 'Release it');
    const task = await taskOfSession(request, threadId);
    expect(task.status).toBe('input-required');

    await page.goto(`/tasks/${task.id}`);

    await expect(page.getByText('Waiting for input', { exact: true })).toBeVisible();
    await expect(page.getByText('Which environment should the release go to?')).toBeVisible();
    await checkA11y('a task waiting on a question');
    await page.getByLabel('Your answer').fill('staging');
    await page.getByRole('button', { name: 'Send answer' }).click();

    // The page reads the task again, and the stream carries what the run answers.
    await expect(page.getByText('Completed', { exact: true })).toBeVisible();
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
    const { taskId } = await runningBarrierTask(request, 'tasks-follow');
    const resumes: Array<string | undefined> = [];
    page.on('request', (outgoing) => {
      if (outgoing.url().includes('/bureau/v1/subscriptions/bureau.tasks.events')) {
        resumes.push(outgoing.headers()['last-event-id']);
      }
    });

    await page.goto(`/tasks/${taskId}`);
    await expect(page.getByText('Working', { exact: true })).toBeVisible();
    // The stream's snapshot has no position to resume from, so the page keeps nothing yet.
    await expect.poll(() => resumes.length).toBeGreaterThanOrEqual(1);
    expect(resumes[0]).toBeUndefined();

    // The connection drops, and the run finishes while the page cannot hear it.
    await context.setOffline(true);
    await expect(page.getByText(TASK_COPY.followReconnecting)).toBeVisible();
    await releaseBarrier(request);
    await expect
      .poll(async () => ((await bureauCall(request, 'bureau.tasks.get', { taskId })) as { status: string }).status)
      .toBe('completed');

    await context.setOffline(false);
    await expect(page.getByText('Completed', { exact: true })).toBeVisible();
    await expect(page.getByText(BARRIER_REPLY)).toBeVisible();
    const cursor = await keptCursor(page, taskId);
    expect(cursor).not.toBeNull();

    // After a full reload the page resumes from the cursor it kept, and still has the answer.
    resumes.length = 0;
    await page.reload();
    await expect(page.getByText('Completed', { exact: true })).toBeVisible();
    await expect(page.getByText(BARRIER_REPLY)).toBeVisible();
    await expect.poll(() => resumes.length).toBeGreaterThanOrEqual(1);
    expect(resumes[0]).toBe(cursor);
  });
});

test.describe('cancelling a task', () => {
  test('shows the cancellation until its cleanup is done, and then says it is cleaned up', async ({
    page,
    request,
    checkA11y,
  }) => {
    const { taskId, abort } = await runningBarrierTask(request, 'tasks-cancel');
    try {
      await page.goto(`/tasks/${taskId}`);
      await expect(page.getByText('Working', { exact: true })).toBeVisible();
      await checkA11y('a task that can be cancelled');

      await page.getByRole('button', { name: 'Cancel task' }).click();

      await expect(page.getByText(TASK_COPY.cancel['cleaned-up'])).toBeVisible();
      await expect(page.getByText('Canceled', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
      await checkA11y('a task that was cleaned up');
    } finally {
      abort();
    }
  });
});

for (const width of WIDTHS) {
  test(`a task’s page fits at ${width} pixels, and passes axe`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const threadId = newThreadId('tasks-width');
    await runToEnd(request, 'request-human-input', threadId, 'Release it');
    const task = await taskOfSession(request, threadId);

    await page.goto(`/tasks/${task.id}`);

    await expect(page.getByLabel('Your answer')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await checkA11y(`a task waiting on a question at ${width}px`);
  });
}
