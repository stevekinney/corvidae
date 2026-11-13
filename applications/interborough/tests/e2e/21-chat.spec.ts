/**
 * Chat at `/chats/:chat` against the real host: a message sent, a follow-up sent while the run
 * is going (held on the barrier so nothing depends on a clock), an approval decided in its row under the call,
 * and a reload while a run is going. Sessions are started through the AG-UI mount, the way a client
 * other than the page would, because starting one from the page belongs to `/chats/new`.
 */
import type { Page } from '@playwright/test';

import { CHAT_COPY } from '../../src/app/copy/chat.ts';
import { VIEW_COPY } from '../../src/app/copy/view-pages.ts';
import {
  approveThroughMount,
  conversation,
  expectWaiting,
  newThreadId,
  releaseBarrier,
  runToEnd,
} from './chat-support.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

const BARRIER = 'barrier';
const BARRIER_SHORT = 'barrier-short';
const FIRST_REPLY = 'The barrier opened.';
const FOLLOW_UP_REPLY = 'The follow-up was delivered.';
const REFUNDED = 'Order order-1001 was refunded.';
const NOT_ISSUED = 'The refund of order order-1001 was not issued.';

const composer = (page: Page) => page.getByRole('textbox');

/** The Up next drawer, where a follow-up typed while a run works waits for it (COR-2284). */
const upNext = (page: Page) => page.locator('[data-chat-follow-up-drawer]');

/**
 * Sends a follow-up to the run that is going: typed, it waits in Up next, and Send now instead hands
 * it to the run as live input (COR-2284). Waits for the Bureau to answer the input, so what follows
 * acts on an admitted input.
 */
async function sendFollowUp(page: Page, text: string): Promise<void> {
  await send(page, text);
  await expect(upNext(page)).toContainText(text);
  const answered = page.waitForResponse(
    (response) =>
      response.url().endsWith('/bureau/jsonrpc') &&
      (response.request().postData() ?? '').includes('"bureau.contexts.input"'),
  );
  await upNext(page).getByRole('button', { name: 'Send now instead' }).click();
  await answered;
  await expect(upNext(page)).toHaveCount(0);
}

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
    const threadId = newThreadId('demo:assistant');
    await runToEnd(request, 'demo:assistant', threadId, 'First hello');

    await page.goto(`/chats/${threadId}`);

    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('First hello');
    // The header is the title and its status: the agent is named once, where a message goes to it
    // (the composer), and in the details the breadcrumb opens, not on a line under the title.
    const region = page.getByRole('region', { name: 'Conversation' });
    await expect(region.getByText('demo:assistant', { exact: true })).toHaveCount(0);
    await expect(region.getByRole('textbox', { name: 'Message' })).toHaveAttribute(
      'placeholder',
      'Message Assistant…',
    );
    // The assistant's reply is scripted, so both turns answer with the same words: the seeded turn's
    // reply is on the page before the send, and the answer to it is a second copy after the message
    // that asked for it. A lone `toBeVisible()` matched the seeded reply until the new one rendered,
    // then failed strict mode (COR-2412), so the counts are exact and the order is checked.
    const reply = conversation(page).getByText('Hello from the assistant.');
    await expect(reply).toHaveCount(1);
    await send(page, 'Hello again');
    await expect(reply).toHaveCount(2);
    const content = (await transcript(page).textContent()) ?? '';
    expect(content.lastIndexOf('Hello from the assistant.')).toBeGreaterThan(
      content.indexOf('Hello again'),
    );
  });
});

test.describe('a tool approval', () => {
  async function toolRunnerSession(
    request: Parameters<typeof runToEnd>[0],
    options: { settled: boolean },
  ): Promise<string> {
    const threadId = newThreadId('demo:tool-runner');
    const stream = await runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001');
    if (options.settled) await approveThroughMount(request, threadId, stream);
    return threadId;
  }

  test('raised by a run the page started is one flat row under its call, and deciding it continues the run', async ({
    page,
    request,
    checkA11y,
  }) => {
    const threadId = await toolRunnerSession(request, { settled: true });
    await page.goto(`/chats/${threadId}`);

    await send(page, 'Refund order-1001 again');

    const alert = page.locator('[data-approval-decision]');
    await expect(alert).toBeVisible();
    // One flat row: the question in the call's own words, with Deny and Approve, and none of the
    // policy's string or the run's identifier anywhere in the view's text.
    await expect(alert).toContainText('Refund order order-1001 for $42.00?');
    const text = (await transcript(page).innerText()) ?? '';
    expect(text).not.toMatch(/requires approval|mutating tier|run-\d/);
    // Two calls are two plain rows of the rail, with no summary: the lookup, and the refund that
    // waits on a decision, whose approval is nested under its own row.
    const rail = conversation(page).getByRole('region', { name: 'Tool calls' });
    await expect(rail.getByRole('button', { name: /^Lookup order/ }).last()).toBeVisible();
    await expect(rail.getByRole('button', { name: /^Issue refund/ })).toContainText(
      'Waiting on you',
    );
    await expect(conversation(page).getByText(/^Used \d+ tools/)).toHaveCount(0);
    await expect(
      conversation(page).locator('code').filter({ hasText: 'issue-refund' }).first(),
    ).toBeVisible();
    // The seeded turn already refunded the order once, so one reply is the one the session opened with.
    await expect(conversation(page).getByText(REFUNDED)).toHaveCount(1);
    // Chat's own card for the approval is not in the transcript: there is one place to decide.
    await expect(page.locator('[data-cinder-tool-approval]')).toHaveCount(0);
    await checkA11y('a session waiting on an approval');
    await alert.getByRole('button', { name: 'Approve' }).click();

    // A second reply is the run going on after the approval; a denial would say it was not issued.
    await expect(conversation(page).getByText(REFUNDED)).toHaveCount(2);
    await expect(conversation(page).getByText(NOT_ISSUED)).toHaveCount(0);
    await expect(alert).toHaveCount(0);
  });

  test('left waiting by a run the page did not start is restored on load and can be denied', async ({
    page,
    request,
  }) => {
    const threadId = await toolRunnerSession(request, { settled: false });

    await page.goto(`/chats/${threadId}`);

    const alert = page.locator('[data-approval-decision]');
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'Deny' }).click();
    await expect(conversation(page).getByText(NOT_ISSUED)).toHaveCount(1);
    await expect(conversation(page).getByText(REFUNDED)).toHaveCount(0);
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
    await page.goto(`/chats/${threadId}`);
    await send(page, 'Refund the order');
    const alert = page.locator('[data-approval-decision]');
    await expect(alert).toBeVisible();

    // The run has stopped on the approval, so a follow-up typed now waits in Up next for the run
    // to finish rather than going to it (COR-2284).
    await send(page, 'And one more thing');
    await expect(upNext(page)).toContainText('And one more thing');
    await alert.getByRole('button', { name: 'Approve' }).click();
    await expect(conversation(page).getByText(REFUNDED)).toHaveCount(2);

    const opener = starts[0]?.messages.at(-1);
    const continuationIndex = starts.findIndex((body) => body.resume !== undefined);
    const continuation = starts[continuationIndex];
    expect(opener?.content).toBe('Refund the order');
    expect(continuation?.messages.map((message) => message.id)).toEqual([opener?.id]);
    expect(JSON.stringify(continuation?.messages)).not.toContain('And one more thing');
    // Once the continued run has finished, the follow-up goes as a turn of its own, after it.
    await expect(upNext(page)).toHaveCount(0);
    await expect
      .poll(() =>
        starts.findIndex((body) => body.messages.at(-1)?.content === 'And one more thing'),
      )
      .toBeGreaterThan(continuationIndex);
    await expect(conversation(page).getByText('And one more thing')).toHaveCount(1);
  });
});

test.describe('a tool call', () => {
  test('is one short row with its summary, and choosing it opens its arguments and its result in a panel', async ({
    page,
    request,
  }) => {
    const threadId = newThreadId('demo:tool-runner');
    const stream = await runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001');
    await approveThroughMount(request, threadId, stream);

    await page.goto(`/chats/${threadId}`);

    const lookup = page.locator('[data-cinder-tool-call-row]').filter({ hasText: 'Lookup order' });
    await expect(lookup).toContainText('order-1001');
    await expect(lookup).toContainText('status delivered');
    const box = await lookup.boundingBox();
    expect(box?.height ?? 999).toBeLessThanOrEqual(48);
    // Choosing the row opens what the call was given and what it answered in the call's panel,
    // beside the conversation, and the rail's rows stay one line each.
    await lookup.click();
    const panel = page.locator('.cinder-tool-call-panel');
    await expect(panel).toContainText('Lookup order');
    const given = panel.getByRole('region', { name: 'Input' });
    await expect(given.getByText('Order ID')).toBeVisible();
    await expect(given.getByText('order-1001')).toBeVisible();
    const answered = panel.getByRole('region', { name: 'Result' });
    await expect(answered.getByText('Total cents')).toBeVisible();
    await expect(answered.getByText('4200')).toBeVisible();
    await expect(page.locator('.ib-tool__details')).toHaveCount(0);
  });
});

test.describe('a turn’s tool calls', () => {
  for (const width of [375, 1280]) {
    test(`are one row each on Cinder's rail without overflowing at ${String(width)} pixels`, async ({
      page,
      request,
    }) => {
      const threadId = newThreadId('demo:tool-runner');
      const stream = await runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001');
      await approveThroughMount(request, threadId, stream);
      await page.setViewportSize({ width, height: 812 });
      await page.goto(`/chats/${threadId}`);

      await expect(page.locator('[data-cinder-tool-call-row]')).toHaveCount(2);
      await expect(page.locator('.cinder-tool-call-rail')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  }
});

test.describe('a follow-up sent while the run is going', () => {
  test('is delivered to the same run, which answers it after the reply it arrived during', async ({
    page,
    request,
  }) => {
    const threadId = await idleBarrierSession(request, BARRIER, 'delivered');
    await page.goto(`/chats/${threadId}`);
    await send(page, 'Start the work');
    await expectWaiting(request, 1);

    await sendFollowUp(page, 'Also this');
    await releaseBarrier(request);

    await expect(conversation(page).getByText(FOLLOW_UP_REPLY)).toBeVisible();
    expect(await indexIn(page, FIRST_REPLY)).toBeLessThan(await indexIn(page, 'Also this'));
    expect(await indexIn(page, 'Also this')).toBeLessThan(await indexIn(page, FOLLOW_UP_REPLY));
    await expect(conversation(page).getByText('Also this')).toHaveCount(1);
  });

  test('is sent again as an ordinary turn when the run ends before it could be delivered', async ({
    page,
    request,
  }) => {
    const threadId = await idleBarrierSession(request, BARRIER_SHORT, 'ended');
    await page.goto(`/chats/${threadId}`);
    await send(page, 'Start the work');
    await expectWaiting(request, 1);

    await sendFollowUp(page, 'Also this');
    await releaseBarrier(request);

    // The run ended without delivering it, so the next run answers it, in the same conversation.
    await expectWaiting(request, 1);
    await releaseBarrier(request);
    // The seeding turn's reply is restored with the transcript, and each run since adds its own.
    await expect(conversation(page).getByText(FIRST_REPLY)).toHaveCount(3);
    await expect(conversation(page).getByText('Also this')).toHaveCount(1);
    const content = (await transcript(page).textContent()) ?? '';
    expect(await indexIn(page, 'Also this')).toBeLessThan(content.lastIndexOf(FIRST_REPLY));
  });

  test('is marked failed with a retry when this client stopped the run, and retrying sends it as a turn', async ({
    page,
    request,
  }) => {
    const threadId = await idleBarrierSession(request, BARRIER, 'stopped');
    await page.goto(`/chats/${threadId}`);
    await send(page, 'Start the work');
    await expectWaiting(request, 1);
    await sendFollowUp(page, 'Also this');

    await page.getByRole('button', { name: /stop/i }).click();

    await expect(page.getByRole('status').filter({ hasText: 'Not sent' })).toBeVisible();
    await page.getByRole('button', { name: 'Not sent: details' }).click();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry' }).click();
    await expectWaiting(request, 1);
    await releaseBarrier(request);
    await expect(conversation(page).getByText(FIRST_REPLY)).toHaveCount(2);
    await expect(conversation(page).getByText('Also this')).toHaveCount(1);
  });
});

test.describe('leaving a chat while its run is going', () => {
  test('leaves the run going, so coming back inside the app joins it and the follow-up is answered', async ({
    page,
    request,
  }) => {
    const threadId = await idleBarrierSession(request, BARRIER, 'leave');
    await page.goto(`/chats/${threadId}`);
    await send(page, 'Start the work');
    await expectWaiting(request, 1);
    await sendFollowUp(page, 'Also this');

    // Inside the app, which tears the page down without unloading it: only a Stop cancels a run.
    await page.getByRole('link', { name: 'Agents', exact: true }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/chats/${threadId}$`));
    // The page joined the run it left: its transcript is the thread as the Bureau holds it.
    await expect(conversation(page).getByText('Start the work')).toBeVisible();
    await expectWaiting(request, 1);

    await releaseBarrier(request);

    await expect(conversation(page).getByText(FOLLOW_UP_REPLY)).toBeVisible();
    await expect(conversation(page).getByText(FIRST_REPLY)).toHaveCount(2);
    await expect(conversation(page).getByText('Also this')).toHaveCount(1);
  });
});

test.describe('a run that asks the person a question', () => {
  const QUESTION = 'Which environment should the release go to?';
  const THANKS = 'Thanks, the release will go to the environment you named.';

  test('shows the question, and the next message answers it and finishes the run', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/chats/new?agent=demo:request-human-input');
    await send(page, 'Ship it');
    const question = page.locator('.weft-chat-question').filter({ hasText: QUESTION });
    await expect(question).toBeVisible();
    await checkA11y('a chat waiting on the person’s answer');

    await send(page, 'staging');

    await expect(conversation(page).getByText(THANKS)).toBeVisible();
    await expect(question).toHaveCount(0);
    await expect(conversation(page).getByText('The agent did not answer')).toHaveCount(0);
    // The answer is one row, the one the run holds, and not the typed one beside it.
    await expect(conversation(page).getByText('staging')).toHaveCount(1);
    // The session is not stuck: it takes another message, and the agent asks again.
    await send(page, 'One more release');
    await expect(question).toBeVisible();
  });

  test('is shown again when the page opens on the session, and answering it does not start a new run', async ({
    page,
    request,
  }) => {
    const threadId = newThreadId('human');
    await runToEnd(request, 'demo:request-human-input', threadId, 'Ship it');
    const starts: Array<{ messages: unknown[]; resume?: unknown }> = [];
    page.on('request', (outgoing) => {
      if (outgoing.method() === 'POST' && outgoing.url().includes('/ag-ui/agents/')) {
        starts.push(outgoing.postDataJSON());
      }
    });

    await page.goto(`/chats/${threadId}`);
    await expect(page.locator('.weft-chat-question').filter({ hasText: QUESTION })).toBeVisible();
    await send(page, 'staging');

    await expect(conversation(page).getByText(THANKS)).toBeVisible();
    expect(starts).toHaveLength(1);
    expect(starts[0]?.messages).toEqual([]);
    expect(JSON.stringify(starts[0]?.resume)).toContain('"answer":"staging"');
  });
});

test('a reload while the run is going restores the transcript and continues live', async ({
  page,
  request,
}) => {
  const threadId = await idleBarrierSession(request, BARRIER, 'reload');
  await page.goto(`/chats/${threadId}`);
  await send(page, 'Start the work');
  await expectWaiting(request, 1);

  await page.reload();

  // The run was not the page's: its transcript comes from the stream's snapshot.
  await expect(conversation(page).getByText('Start the work')).toBeVisible();
  // The seeding turn's reply is in the restored transcript, and this run's is not there yet.
  await expect(conversation(page).getByText(FIRST_REPLY)).toHaveCount(1);
  await releaseBarrier(request);
  await expect(conversation(page).getByText(FIRST_REPLY)).toHaveCount(2);
});

/** The one request the chat pane makes for a session, answered the way the server would. */
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
      await runToEnd(request, 'demo:assistant', threadId, 'Hello');
      await page.goto(`/chats/${threadId}`);
      await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
      await expect(page.getByRole('textbox')).toBeVisible();
      await checkA11y(`a session, ready, at ${width}px`);
    });

    test('is not found for a session that does not exist, with the words copy.ts holds, beside a live list', async ({
      page,
      checkA11y,
    }) => {
      await page.goto('/chats/no-such-session');
      const frame = page.locator('[data-view="chat"]');
      await expect(frame.getByRole('heading', { level: 1 })).toHaveText(
        VIEW_COPY.chat.notFound?.title ?? '',
      );
      // Beside a list that stays live where there is room for both; a phone shows one at a time.
      if (width > 640) {
        await expect(
          frame.getByRole('region', { name: 'Open chat' }).getByRole('link', { name: 'New chat' }),
        ).toBeVisible();
        // The list beside it keeps its own "+", which is named the same.
        await expect(
          frame.getByRole('region', { name: 'Chats' }).getByRole('link', { name: 'New chat' }),
        ).toBeVisible();
      }
      await checkA11y(`a session, not found, at ${width}px`);
    });

    for (const outcome of ['loading', 'error', 'forbidden'] as const) {
      test(`is ${outcome} in the conversation area when the Bureau answers that way, and passes axe`, async ({
        page,
        checkA11y,
        pageErrors,
      }) => {
        if (outcome !== 'loading') {
          pageErrors.expectEvery({
            pattern: loggedFailedResponse(outcome === 'error' ? 500 : 403, /bureau\/jsonrpc/),
            reason: `the test answers the session read with a ${outcome === 'error' ? 500 : 403}`,
          });
        }
        await answerSessionProbe(page, outcome);
        await page.goto('/chats/any-session');
        const frame = page.locator('[data-view="chat"]');
        // The chat's own states are drawn by its pane, so the frame, and the list in it, stay up.
        await expect(frame).toHaveAttribute('data-state', 'ready');
        if (outcome === 'loading') {
          await expect(page.getByTestId('chat-loading')).toBeVisible();
          await expect(page.getByRole('textbox', { name: /^Message/ })).toBeDisabled();
        } else {
          await expect(frame.getByRole('heading', { level: 1 })).toHaveText(
            outcome === 'error' ? CHAT_COPY.load.errorTitle : VIEW_COPY.chat.forbidden.title,
          );
        }
        // The list beside it stays live where there is room for both, with its own "+".
        if (width > 640) {
          await expect(
            frame.getByRole('region', { name: 'Chats' }).getByRole('link', { name: 'New chat' }),
          ).toBeVisible();
        }
        await checkA11y(`a session, ${outcome}, at ${width}px`);
      });
    }
  });
}

for (const width of [375, 1280] as const) {
  test.describe(`a new chat's agent card at ${width} pixels`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test('greets the agent, says what it does and offers its example prompt, and a prompt fills the composer without sending it', async ({
      page,
      checkA11y,
    }) => {
      await page.goto('/chats/new?agent=demo:tool-runner');

      const welcome = page.getByTestId('new-chat-welcome');
      await expect(welcome).toBeVisible();
      await expect(welcome.getByRole('heading', { level: 1 })).toHaveText(
        'What should Tool runner do?',
      );
      await expect(welcome).toContainText(
        'Looks an order up, then asks for approval to refund it.',
      );
      // The greeting is the page's one title: there is no header over it.
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      // The other agents are offered whichever agent is chosen, and the chosen one is not repeated.
      const others = page.getByRole('group', { name: 'Or chat with' });
      await expect(others).toBeVisible();
      await expect(others.getByRole('button', { name: /Tool runner/ })).toHaveCount(0);
      await checkA11y(`a new chat greeting the tool-runner at ${width}px`);

      await page
        .getByTestId('agent-prompts')
        .getByRole('button', { name: 'Refund order 1234' })
        .click();

      await expect(composer(page)).toHaveValue('Refund order 1234');
      await expect(composer(page)).toBeFocused();
      // Filling the composer starts nothing: the address is still the new chat's.
      await expect(page).toHaveURL(/\/chats\/new\?agent=demo(?::|%3A)tool-runner$/);
    });

    test('wraps a long example prompt inside its button, and the outlet does not scroll sideways', async ({
      page,
    }) => {
      // The longest prompt the Bureau allows, with a word too long for any line.
      const prompt = `Look up ${'x'.repeat(150)} and refund it`;
      expect(prompt.length).toBeLessThanOrEqual(200);
      await page.route('**/bureau/jsonrpc', async (route) => {
        if (!(route.request().postData() ?? '').includes('"bureau.agents.list"')) {
          await route.fallback();
          return;
        }
        const response = await route.fetch();
        const body = await response.json();
        for (const agent of body.result.agents) {
          if (agent.name === 'demo:tool-runner') agent.examples = [prompt];
        }
        await route.fulfill({ response, json: body });
      });
      await page.goto('/chats/new?agent=demo:tool-runner');

      const button = page.getByTestId('agent-prompts').getByRole('button', { name: prompt });
      await expect(button).toBeVisible();
      const outlet = page.locator('main.weft-shell-outlet');
      const outletBox = await outlet.boundingBox();
      const buttonBox = await button.boundingBox();
      expect(buttonBox?.x ?? 0).toBeGreaterThanOrEqual((outletBox?.x ?? 0) - 1);
      expect((buttonBox?.x ?? 0) + (buttonBox?.width ?? 0)).toBeLessThanOrEqual(
        (outletBox?.x ?? 0) + (outletBox?.width ?? 0) + 1,
      );
      // It wrapped: taller than a line and a half of its own text.
      expect(
        await button.evaluate(
          (element) =>
            element.clientHeight > parseFloat(getComputedStyle(element).lineHeight) * 1.5,
        ),
      ).toBe(true);
      // Neither the outlet nor the page scrolls sideways.
      expect(await outlet.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });

    test('offers the other agents as one row, and choosing one selects it', async ({
      page,
      checkA11y,
    }) => {
      await page.goto('/chats/new');
      const welcome = page.getByTestId('new-chat-welcome');
      await expect(welcome.getByRole('heading', { level: 1 })).toContainText(/What should .* do\?/);
      const others = page.getByRole('group', { name: 'Or chat with' });
      await expect(others).toBeVisible();
      await checkA11y(`a new chat with the agents to choose from at ${width}px`);

      await others.getByRole('button', { name: /request human input/i }).click();

      await expect(page).toHaveURL(/\/chats\/new\?agent=demo%3Arequest-human-input$/);
      await expect(welcome.getByRole('heading', { level: 1 })).toHaveText(
        'What should Request human input do?',
      );
      await expect(page.getByTestId('agent-prompts').getByRole('button')).toHaveText(
        'Ship the release',
      );
      // The row stays, and now lists the agent that was left behind instead of the chosen one.
      await expect(others).toBeVisible();
      await expect(others.getByRole('button', { name: /request human input/i })).toHaveCount(0);
    });
  });
}
