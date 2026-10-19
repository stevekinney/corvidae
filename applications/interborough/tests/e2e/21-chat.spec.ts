/**
 * Chat at `/chat/:sessionId` against the real host: a message sent, a follow-up sent while the run
 * is going (held on the barrier so nothing depends on a clock), an approval decided in the page,
 * and a reload while a run is going. Sessions are started through the AG-UI mount, the way a client
 * other than the page would, because starting one from the page belongs to `/chat/new`.
 */
import type { Page } from '@playwright/test';

import { VIEW_COPY } from '../../src/app/copy.ts';
import {
  approveThroughMount,
  expectWaiting,
  newThreadId,
  releaseBarrier,
  runToEnd,
} from './chat-support.ts';
import { expect, test } from './fixtures.ts';

const BARRIER = 'barrier';
const BARRIER_SHORT = 'barrier-short';
const FIRST_REPLY = 'The barrier opened.';
const FOLLOW_UP_REPLY = 'The follow-up was delivered.';

const composer = (page: Page) => page.getByRole('textbox');

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** A session whose agent is a barrier agent, finished, so the page opens on an idle session. */
async function idleBarrierSession(
  request: Parameters<typeof runToEnd>[0],
  agent: string,
  label: string,
): Promise<string> {
  const threadId = newThreadId(label);
  const finished = runToEnd(request, agent, threadId, 'Seed the session');
  await expectWaiting(request, 1);
  await releaseBarrier(request);
  await finished;
  return threadId;
}

/** The transcript's text, so the order of what it shows can be asserted. */
const transcript = (page: Page) => page.locator('[data-session]');

async function indexIn(page: Page, text: string): Promise<number> {
  const content = (await transcript(page).textContent()) ?? '';
  return content.indexOf(text);
}

test.describe('a session', () => {
  test('answers a message and shows the header once', async ({ page, request }) => {
    const threadId = newThreadId('assistant');
    await runToEnd(request, 'assistant', threadId, 'First hello');

    await page.goto(`/chat/${threadId}`);

    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('First hello');
    await expect(page.getByText('assistant', { exact: true })).toHaveCount(1);
    await send(page, 'Hello again');
    await expect(page.getByText('Hello from the assistant.')).toBeVisible();
  });
});

test.describe('a tool approval', () => {
  async function toolRunnerSession(
    request: Parameters<typeof runToEnd>[0],
    options: { settled: boolean },
  ): Promise<string> {
    const threadId = newThreadId('tool-runner');
    const stream = await runToEnd(request, 'tool-runner', threadId, 'Refund order-1001');
    if (options.settled) await approveThroughMount(request, threadId, stream);
    return threadId;
  }

  test('raised by a run the page started is decided in the alert above the transcript', async ({
    page,
    request,
    checkA11y,
  }) => {
    const threadId = await toolRunnerSession(request, { settled: true });
    await page.goto(`/chat/${threadId}`);

    await send(page, 'Refund order-1001 again');

    const alert = page.getByRole('alert').filter({ hasText: 'Needs your approval' });
    await expect(alert).toBeVisible();
    await expect(page.getByText('lookup-order').first()).toBeVisible();
    // Chat's own card for the approval is not in the transcript: there is one place to decide.
    await expect(page.locator('[data-cinder-tool-approval]')).toHaveCount(0);
    await checkA11y('a session waiting on an approval');
    await alert.getByRole('button', { name: 'Approve' }).click();

    await expect(page.getByText('Order order-1001 was refunded.')).toBeVisible();
    await expect(alert).toHaveCount(0);
  });

  test('left waiting by a run the page did not start is restored on load and can be denied', async ({
    page,
    request,
  }) => {
    const threadId = await toolRunnerSession(request, { settled: false });

    await page.goto(`/chat/${threadId}`);

    const alert = page.getByRole('alert').filter({ hasText: 'Needs your approval' });
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'Deny' }).click();
    await expect(page.getByText('The refund of order order-1001 was not issued.')).toBeVisible();
    await expect(alert).toHaveCount(0);
  });

  test('is continued by the turn that opened the run, never by a follow-up sent while it waited', async ({
    page,
    request,
  }) => {
    const threadId = await toolRunnerSession(request, { settled: true });
    const starts: Array<{ messages: Array<{ id: string; content: string }>; resume?: unknown }> =
      [];
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'POST' && outgoing.url().includes('/ag-ui/agents/')) {
        starts.push(outgoing.postDataJSON());
      }
    });
    await page.goto(`/chat/${threadId}`);
    await send(page, 'Refund the order');
    const alert = page.getByRole('alert').filter({ hasText: 'Needs your approval' });
    await expect(alert).toBeVisible();

    // The run has stopped on the approval, so nothing is going to deliver this follow-up.
    await send(page, 'And one more thing');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await alert.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('Order order-1001 was refunded.')).toBeVisible();

    const opener = starts[0]?.messages.at(-1);
    const continuation = starts.find((body) => body.resume !== undefined);
    expect(opener?.content).toBe('Refund the order');
    expect(continuation?.messages.map((message) => message.id)).toEqual([opener?.id]);
    expect(JSON.stringify(continuation?.messages)).not.toContain('And one more thing');
  });
});

test.describe('a follow-up sent while the run is going', () => {
  test('is delivered to the same run, which answers it after the reply it arrived during', async ({
    page,
    request,
  }) => {
    const threadId = await idleBarrierSession(request, BARRIER, 'delivered');
    await page.goto(`/chat/${threadId}`);
    await send(page, 'Start the work');
    await expectWaiting(request, 1);

    await send(page, 'Also this');
    await expect(page.getByText('Sending…')).toHaveCount(0);
    await releaseBarrier(request);

    await expect(page.getByText(FOLLOW_UP_REPLY)).toBeVisible();
    expect(await indexIn(page, FIRST_REPLY)).toBeLessThan(await indexIn(page, 'Also this'));
    expect(await indexIn(page, 'Also this')).toBeLessThan(await indexIn(page, FOLLOW_UP_REPLY));
    await expect(page.getByText('Also this')).toHaveCount(1);
  });

  test('is sent again as an ordinary turn when the run ends before it could be delivered', async ({
    page,
    request,
  }) => {
    const threadId = await idleBarrierSession(request, BARRIER_SHORT, 'ended');
    await page.goto(`/chat/${threadId}`);
    await send(page, 'Start the work');
    await expectWaiting(request, 1);

    await send(page, 'Also this');
    await releaseBarrier(request);

    // The run ended without delivering it, so the next run answers it, in the same conversation.
    await expectWaiting(request, 1);
    await releaseBarrier(request);
    await expect(page.getByText(FIRST_REPLY)).toHaveCount(2);
    await expect(page.getByText('Also this')).toHaveCount(1);
    const content = (await transcript(page).textContent()) ?? '';
    expect(await indexIn(page, 'Also this')).toBeLessThan(content.lastIndexOf(FIRST_REPLY));
  });

  test('is marked failed with a retry when this client stopped the run, and retrying sends it as a turn', async ({
    page,
    request,
  }) => {
    const threadId = await idleBarrierSession(request, BARRIER, 'stopped');
    await page.goto(`/chat/${threadId}`);
    await send(page, 'Start the work');
    await expectWaiting(request, 1);
    await send(page, 'Also this');

    await page.getByRole('button', { name: /stop/i }).click();

    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry' }).click();
    await expectWaiting(request, 1);
    await releaseBarrier(request);
    await expect(page.getByText(FIRST_REPLY)).toBeVisible();
    await expect(page.getByText('Also this')).toHaveCount(1);
  });
});

test('a reload while the run is going restores the transcript and continues live', async ({
  page,
  request,
}) => {
  const threadId = await idleBarrierSession(request, BARRIER, 'reload');
  await page.goto(`/chat/${threadId}`);
  await send(page, 'Start the work');
  await expectWaiting(request, 1);

  await page.reload();

  // The run was not the page's: its transcript comes from the stream's snapshot.
  await expect(page.getByText('Start the work')).toBeVisible();
  // The seeding turn's reply is in the restored transcript, and this run's is not there yet.
  await expect(page.getByText(FIRST_REPLY)).toHaveCount(1);
  await releaseBarrier(request);
  await expect(page.getByText(FIRST_REPLY)).toHaveCount(2);
});

/** The one request the view frame's probe makes for a session, answered the way the server would. */
async function answerSessionProbe(
  page: Page,
  outcome: 'loading' | 'error' | 'forbidden',
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    if (!(route.request().postData() ?? '').includes('"bureau.contexts.get"')) {
      await route.fallback();
      return;
    }
    if (outcome === 'loading') return;
    await route.fulfill(
      outcome === 'error'
        ? { status: 500, json: { error: 'The server broke.' } }
        : { status: 403, json: { error: 'Forbidden' } },
    );
  });
}

for (const width of [375, 1280] as const) {
  test.describe(`a session's view at ${width} pixels`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test('is ready for a session the caller can see, and passes axe', async ({
      page,
      request,
      checkA11y,
    }) => {
      const threadId = newThreadId('states');
      await runToEnd(request, 'assistant', threadId, 'Hello');
      await page.goto(`/chat/${threadId}`);
      await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
      await expect(page.getByRole('textbox')).toBeVisible();
      await checkA11y(`a session, ready, at ${width}px`);
    });

    test('is not found for a session that does not exist, with the words copy.ts holds', async ({
      page,
      checkA11y,
    }) => {
      await page.goto('/chat/no-such-session');
      const frame = page.locator('[data-view="chat"]');
      await expect(frame).toHaveAttribute('data-state', 'not-found');
      await expect(frame.getByRole('heading', { level: 1 })).toHaveText(
        VIEW_COPY.chat.notFound?.title ?? '',
      );
      await checkA11y(`a session, not found, at ${width}px`);
    });

    for (const outcome of ['loading', 'error', 'forbidden'] as const) {
      test(`is ${outcome} when the Bureau answers that way, and passes axe`, async ({
        page,
        checkA11y,
      }) => {
        await answerSessionProbe(page, outcome);
        await page.goto('/chat/any-session');
        const frame = page.locator('[data-view="chat"]');
        await expect(frame).toHaveAttribute('data-state', outcome);
        await expect(frame.getByRole('heading', { level: 1 })).toHaveText(
          VIEW_COPY.chat[outcome].title,
        );
        await checkA11y(`a session, ${outcome}, at ${width}px`);
      });
    }
  });
}
