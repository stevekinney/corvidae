/**
 * Chat when a run asks the person more than one thing, and when a stop comes before the run has
 * said anything (COR-1590). The agents ask in turn (`question-agents.ts`): the Bureau parks a run on
 * one thing at a time. The page answers each in its place, shows the answers as they were typed
 * now and after a reload, and sends what the run is owed. A stop pressed while the mount has not
 * yet answered the start is held until the run has a name, and then cancels that run. A session
 * the address cannot carry is opened by the address the page builds for it, and the mount refuses
 * to create one it could not be opened again by.
 */
import type { Page } from '@playwright/test';

import { CHAT_COPY } from '../../src/app/copy.ts';
import { chatSessionPath } from '../../src/lib/identifier-paths.ts';
import { expectWaiting, newThreadId, releaseBarrier, runToEnd } from './chat-support.ts';
import { E2E_BASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import {
  ENVIRONMENT_QUESTION,
  QUESTION_AND_APPROVAL_AGENT_NAME,
  REGION_QUESTION,
  RELEASE_SENT,
  TWO_QUESTIONS_AGENT_NAME,
  TWO_QUESTIONS_THANKS,
} from './question-agents.ts';
import { tasksOfSession } from './task-support.ts';

const composer = (page: Page) => page.getByRole('textbox');

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

const question = (page: Page, text: string) => page.getByRole('alert').filter({ hasText: text });

/** The AG-UI start requests the page makes, each as the JSON it sent. */
function recordStarts(
  page: Page,
): Array<{ messages: unknown[]; resume?: Array<{ interruptId: string }> }> {
  const starts: Array<{ messages: unknown[]; resume?: Array<{ interruptId: string }> }> = [];
  page.on('request', (outgoing) => {
    if (outgoing.method() === 'POST' && outgoing.url().includes('/ag-ui/agents/')) {
      starts.push(outgoing.postDataJSON());
    }
  });
  return starts;
}

test.describe('a run that asks two questions', () => {
  test('shows each in turn, answers each in its place, and shows the answers as they were typed, now and after a reload', async ({
    page,
    checkA11y,
  }) => {
    const starts = recordStarts(page);
    await page.goto(`/chat/new?agent=${TWO_QUESTIONS_AGENT_NAME}`);
    await send(page, 'Ship it');
    await expect(question(page, ENVIRONMENT_QUESTION)).toBeVisible();

    await send(page, 'staging');

    // The second question replaces the first, and the first answer is one row, as typed.
    await expect(question(page, REGION_QUESTION)).toBeVisible();
    await expect(question(page, ENVIRONMENT_QUESTION)).toHaveCount(0);
    await expect(page.getByText('staging', { exact: true })).toHaveCount(1);
    await checkA11y('a chat waiting on the second of two questions');

    await send(page, 'eu');

    await expect(page.getByText(TWO_QUESTIONS_THANKS)).toBeVisible();
    await expect(question(page, REGION_QUESTION)).toHaveCount(0);
    await expect(page.getByText('staging', { exact: true })).toHaveCount(1);
    await expect(page.getByText('eu', { exact: true })).toHaveCount(1);
    await expect(page.getByText('[signal:')).toHaveCount(0);
    // One start, then one resume for each answer.
    expect(starts.map((body) => body.resume?.length ?? 0)).toEqual([0, 1, 1]);

    await page.reload();

    await expect(page.getByText(TWO_QUESTIONS_THANKS)).toBeVisible();
    await expect(page.getByText('staging', { exact: true })).toHaveCount(1);
    await expect(page.getByText('eu', { exact: true })).toHaveCount(1);
    await expect(page.getByText('[signal:')).toHaveCount(0);
  });
});

test.describe('a run that asks a question and then for an approval', () => {
  test('is answered, then decided, and shows the answer once as it was typed', async ({
    page,
    checkA11y,
  }) => {
    const starts = recordStarts(page);
    await page.goto(`/chat/new?agent=${QUESTION_AND_APPROVAL_AGENT_NAME}`);
    await send(page, 'Ship it');
    await expect(question(page, ENVIRONMENT_QUESTION)).toBeVisible();

    await send(page, 'staging');

    const approval = page.locator('.ib-decision');
    await expect(approval).toBeVisible();
    await expect(question(page, ENVIRONMENT_QUESTION)).toHaveCount(0);
    await expect(page.getByText('staging', { exact: true })).toHaveCount(1);
    await checkA11y('a chat waiting on an approval after a question');
    await approval.getByRole('button', { name: 'Approve' }).click();

    await expect(page.getByText(RELEASE_SENT)).toBeVisible();
    await expect(approval).toHaveCount(0);
    await expect(page.getByText('staging', { exact: true })).toHaveCount(1);
    expect(starts.map((body) => body.resume?.length ?? 0)).toEqual([0, 1, 1]);
  });
});

test.describe('a stop before the run’s first event', () => {
  const FIRST_REPLY = 'The barrier opened.';

  test('cancels the run once its first event names it, and the next message starts a run', async ({
    page,
    request,
  }) => {
    // The session exists, and its agent is the barrier agent, so a run on it waits on the barrier.
    const threadId = newThreadId('early-stop');
    const seeded = runToEnd(request, 'barrier', threadId, 'Seed the session');
    await expectWaiting(request, 1);
    await releaseBarrier(request);
    await seeded;
    const cancels: string[] = [];
    page.on('request', (outgoing) => {
      if (outgoing.url().includes('/cancel')) cancels.push(outgoing.url());
    });

    // The mount admits the start, and its answer is held on the way to the page: the run exists,
    // and nothing the page has read names it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reached!: () => void;
    const holding = new Promise<void>((resolve) => {
      reached = resolve;
    });
    await page.route('**/ag-ui/agents/barrier/run', async (route) => {
      const upstream = await fetch(route.request().url(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: route.request().postData() ?? '',
      });
      upstreamReader = upstream.body?.getReader();
      // Read to the end of the first event, which is the one that names the run.
      let first = '';
      while (!first.includes('\n\n')) {
        const chunk = await upstreamReader?.read();
        if (chunk === undefined || chunk.done) break;
        first += new TextDecoder().decode(chunk.value);
      }
      reached();
      await held;
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: first,
      });
    });
    try {
      await page.goto(`/chat/${threadId}`);
      await send(page, 'Start the work');
      await holding;
      await expectWaiting(request, 1);

      await page.getByRole('button', { name: /stop/i }).click();

      // Nothing names the run yet, so nothing was cancelled. The page shows the turn as stopped, and
      // its composer takes nothing until the run has been cancelled.
      await expect(page.getByText(CHAT_COPY.stopping)).toBeVisible();
      await expect(composer(page)).toBeDisabled();
      expect(cancels).toEqual([]);
      release();

      // The first event names the run, and the page cancels it: the barrier's step is aborted.
      await expectWaiting(request, 0);
      await expect.poll(() => cancels.length).toBe(1);
      await expect
        .poll(async () => {
          const [task] = await tasksOfSession(request, threadId);
          return task?.status;
        })
        .toBe('canceled');

      await page.unroute('**/ag-ui/agents/barrier/run');
      await send(page, 'Start again');
      await expectWaiting(request, 1);
      await releaseBarrier(request);
      await expect(page.getByText(FIRST_REPLY)).toHaveCount(2);
      await expect(page.getByText(CHAT_COPY.failureTitle)).toHaveCount(0);
    } finally {
      release();
      await upstreamReader?.cancel().catch(() => undefined);
      await releaseBarrier(request);
    }
  });
});

test.describe('a session whose identifier the address cannot carry', () => {
  test('is opened by the address the page builds for it', async ({ page, request }) => {
    await runToEnd(request, 'assistant', 'new', 'A session named new');

    await page.goto(chatSessionPath('new'));

    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('A session named new');
    await expect(page.locator('[data-session="new"]')).toBeVisible();
    // The new chat is still at its own address.
    await page.goto('/chat/new');
    await expect(page.locator('[data-session="new"]')).toHaveCount(0);
  });

  for (const threadId of ['.', '..']) {
    test(`is refused by the mount when a start would create the session ${threadId}`, async ({
      request,
    }) => {
      const response = await request.post(`${E2E_BASE_URL}/bureau/ag-ui/agents/assistant/run`, {
        headers: { accept: 'text/event-stream' },
        data: {
          threadId,
          runId: `run-${crypto.randomUUID()}`,
          messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: 'Hello' }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      });

      const stream = await response.text();
      expect(stream).toContain('"code":"INVALID_INPUT"');
      expect(stream).toContain('unopenable-session-identifier');
    });
  }
});
