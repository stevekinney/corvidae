/**
 * An open chat on the sample world (`fixtures/sample-world-seed.ts`, the showcase host) at the
 * browser's sample clock, Monday, Nov 2, 10:46 AM Central time (COR-2016, design rows 16a, 16m,
 * 16u, 16v, 17g): the breadcrumb that names the chat, the approval the chat opens on, the details
 * popover the breadcrumb opens, and the Permissions select open. Its states follow (design rows 16y,
 * 17c, 17e, 17j, 17y, 18e, 18i, 18j): loading, slow loading, a chat that cannot be loaded, the server
 * not answering, and an approval answered in Reviews while the chat is open. A state the sample
 * world does not hold is made by answering the Bureau's own operation with what a different world
 * would answer. Each frame is captured for the design review under its own name.
 */
import type { APIRequestContext, Locator, Page, Route } from '@playwright/test';

import {
  SAMPLE_NOW,
  SAMPLE_NOW_MILLISECONDS,
  SAMPLE_TIME_ZONE,
} from '../../fixtures/sample-now.ts';
import { SAMPLE_WORLD_THREADS } from '../../fixtures/sample-world-records.ts';
import { revealSettings } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'chat-page.spec.ts';
const TITLE = 'Please refund order 4471, it arrived damaged.';

/**
 * Answers the host's provider list as it would with a key in place. The sample world holds no key,
 * and Tool runner needs a model, so its composer is the blocked row (rows 06m, 06n, 19f); the
 * frames of the Chat page board captioned "Provider connected" show the live composer instead.
 */
async function connectProvider(page: Page): Promise<void> {
  await page.route('**/host/providers', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { providers: { hasKey: boolean }[] };
    await route.fulfill({
      response,
      json: {
        ...body,
        providers: body.providers.map((provider) => ({ ...provider, hasKey: true })),
      },
    });
  });
}

/** Opens the refund chat at 1280 pixels and waits until its transcript is drawn. */
async function openRefundChat(page: Page): Promise<void> {
  await connectProvider(page);
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('[data-approval-decision]')).toBeVisible();
}

const trail = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });

test.describe('an open chat on the sample world', () => {
  test('reads Chat, then a button naming the chat with a chevron (16a)', async ({ page }) => {
    await openRefundChat(page);
    await expect(trail(page).getByRole('link', { name: 'Chat' })).toBeVisible();
    const button = trail(page).getByRole('button', { name: TITLE });
    await expect(button).toBeVisible();
    await expect(button.locator('svg')).toBeVisible();
    await expect(trail(page)).not.toContainText(SAMPLE_WORLD_THREADS.refund);
  });

  test('scrolls the pending approval into view and focuses it without answering it (16m)', async ({
    page,
  }) => {
    await openRefundChat(page);
    const row = page.locator('[data-approval-decision]');
    await expect(row).toBeFocused();
    await expect(row).toBeInViewport();
    // Nothing was answered: the approval is still waiting, with both choices enabled.
    await expect(row.getByRole('button', { name: 'Approve' })).toBeEnabled();
    await expect(row.getByRole('button', { name: 'Deny' })).toBeEnabled();
    // Issue refund is set to Always, which asks on every call, so allowing it for the rest of the
    // chat is not offered (decision 86).
    await expect(row.getByRole('checkbox')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'approval focused',
      source: SOURCE,
    });
  });

  test('opens the details popover from the breadcrumb: session, agent, started and As run (16u, 16v)', async ({
    page,
  }) => {
    await openRefundChat(page);
    await trail(page).getByRole('button', { name: TITLE }).click();
    const details = page.getByTestId('chat-details');
    await expect(details).toBeVisible();

    await expect(details.getByTestId('chat-details-session')).toHaveText(
      SAMPLE_WORLD_THREADS.refund,
    );
    await expect(details.getByRole('button', { name: 'Copy session ID' })).toBeVisible();
    const agent = details.getByRole('link', { name: 'Tool runner' });
    await expect(agent).toHaveAttribute('href', '/agents/tool-runner');
    await expect(details.locator('code', { hasText: /^tool-runner$/ })).toBeVisible();
    await expect(details).toContainText(/Started\s*Today, 10:30 AM, last active 10:4\d AM/);

    const asRun = details.getByRole('region', { name: 'As run' });
    await expect(asRun).toContainText('Claude Sonnet 5.5');
    await expect(asRun.locator('code', { hasText: /^claude-sonnet-5-5$/ })).toBeVisible();
    await expect(asRun).toContainText(/Effort\s*Medium/);
    await expect(asRun).toContainText(/Permissions\s*On changes asks/);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'details popover open',
      source: SOURCE,
    });
  });

  test('opens the Permissions select with a help line under each option (17g)', async ({
    page,
  }) => {
    await openRefundChat(page);
    // The composer folds its selects into Settings when their values in full do not fit beside Send.
    await revealSettings(page, [{ name: 'Permissions', text: 'On changes asks' }]);
    await page.getByRole('combobox', { name: 'Permissions' }).click();
    // The select keeps all four of the app's modes, in the order of how much they ask.
    await expect(page.getByRole('option')).toHaveCount(4);
    await expect(page.getByRole('option').locator('.cinder-select__option-label')).toHaveText([
      'Always asks',
      'On changes asks',
      'Allow all',
      'Read-only',
    ]);
    const allowAll = page.getByRole('option', { name: /Allow all/ });
    await expect(allowAll).toContainText(
      'Skips the On changes asks for this chat. Tools set to Always still ask; Blocked tools stay blocked.',
    );
    await expect(page.getByRole('option', { name: /^On changes asks/ })).toContainText(
      'Tools set to On changes ask before they run.',
    );
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'permissions select open',
      source: SOURCE,
    });
  });
});

/** Answers the Bureau operation `method` with `answer`, and leaves every other operation to the host. */
async function answerOperation(
  page: Page,
  method: string,
  answer: (route: Route) => Promise<void> | void,
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
    if (body.method === method) {
      await answer(route);
      return;
    }
    await route.fallback();
  });
}

/** The product of the opacities from `locator` up to the page: 1 when nothing dims it. */
const opacityOf = (locator: Locator) =>
  locator.first().evaluate((element) => {
    let node: Element | null = element;
    let product = 1;
    while (node !== null) {
      product *= Number(getComputedStyle(node).opacity);
      node = node.parentElement;
    }
    return product;
  });

const conversationArea = (page: Page) => page.getByRole('region', { name: 'Open chat' });

test.describe('an open chat while it loads (17j, 17y)', () => {
  test('draws nothing for 300 ms, then placeholders in the real layout, with the composer disabled until the chat loads (17j)', async ({
    page,
  }) => {
    await page.clock.pauseAt(SAMPLE_NOW);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await answerOperation(page, 'bureau.contexts.get', async (route) => {
      await gate;
      await route.fallback().catch(() => undefined);
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);
    const loading = page.getByTestId('chat-loading');
    await expect(loading).toBeAttached();
    // A read that is quick never flashes a placeholder.
    await expect(loading.locator('.cinder-skeleton')).toHaveCount(0);
    await expect(loading.getByRole('textbox')).toHaveCount(0);

    await page.clock.runFor(300);
    await expect(loading.locator('.cinder-skeleton').first()).toBeVisible();
    // The composer is the real one: the agent's placeholder, a placeholder for each select, and a
    // Send that cannot be pressed.
    const composer = loading.getByRole('textbox', { name: 'Message' });
    await expect(composer).toHaveAttribute('placeholder', 'Message Tool runner…');
    await expect(composer).toBeDisabled();
    await expect(loading.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await expect(loading.locator('.ib-chat-loading__controls .cinder-skeleton')).toHaveCount(3);
    // The breadcrumb does not show the chat's identifier while the read is out.
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs).toContainText('This chat');
    await expect(crumbs).not.toContainText(SAMPLE_WORLD_THREADS.refund);
    // The status line is for a read that is slow.
    await expect(loading.locator('.cinder-skeleton-status')).toBeEmpty();
    // The list beside it is live.
    await expect(page.locator('[data-chat]')).toHaveCount(5);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'loading',
      source: SOURCE,
    });
    await page.clock.resume();
    release();
    await expect(page.getByTestId('chat-loading')).toHaveCount(0);
  });

  test('says "Still loading this chat…" after 10 s with a ghost Cancel, which returns to the chat list (17y)', async ({
    page,
  }) => {
    await page.clock.pauseAt(SAMPLE_NOW);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await answerOperation(page, 'bureau.contexts.get', async (route) => {
      await gate;
      await route.fallback().catch(() => undefined);
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);
    const loading = page.getByTestId('chat-loading');
    // The skeleton counts from when the pane mounts, so the clock moves once it has.
    await expect(loading).toBeAttached();
    await page.clock.runFor(10_000);

    // Cinder skeleton's own status line, under the placeholders and above the composer, not a banner.
    const status = loading.locator('.cinder-skeleton-status');
    await expect(status).toContainText('Still loading this chat…');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(page.locator('.cinder-banner')).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
    const cancel = status.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toHaveAttribute('data-cinder-variant', 'ghost');
    const statusBox = await status.boundingBox();
    const composerBox = await loading.getByRole('textbox', { name: 'Message' }).boundingBox();
    expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(composerBox!.y);
    await expect(loading.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'slow loading',
      source: SOURCE,
    });

    await cancel.click();
    await expect(page).toHaveURL(/\/chats$/);
    await expect(page.getByTestId('chat-loading')).toHaveCount(0);
    release();
  });
});

test.describe('an open chat that cannot be loaded (17c, 17e)', () => {
  test('is the full error state in place of the conversation, with no banner and no composer, and the list live', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(500, /\/bureau\/jsonrpc/),
      reason: 'the test answers the read of the chat with a 500',
    });
    await answerOperation(page, 'bureau.contexts.get', (route) =>
      route.fulfill({ status: 500, json: { error: 'No.' } }),
    );
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);

    const area = conversationArea(page);
    await expect(
      area.getByRole('heading', { level: 1, name: 'This chat couldn’t be loaded' }),
    ).toBeVisible();
    await expect(area).toContainText(
      'Interborough didn’t send it back. Nothing was lost; the messages are stored with the chat.',
    );
    await expect(area.getByRole('button', { name: 'Try again' })).toHaveAttribute(
      'data-cinder-variant',
      'primary',
    );
    await expect(area.getByRole('button', { name: 'Back to chats' })).toBeVisible();
    // Nothing old to show, so no banner; nothing to send to, so no composer.
    await expect(page.getByRole('region', { name: 'Connection problem' })).toHaveCount(0);
    await expect(area.getByRole('textbox')).toHaveCount(0);
    await expect(page.locator('.weft-chat-surface')).toHaveCount(0);
    // The breadcrumb names the chat that could not be read, and the list beside it stays live.
    await expect(trail(page).getByRole('link', { name: 'Chat' })).toBeVisible();
    await expect(trail(page).getByText('This chat', { exact: true })).toBeVisible();
    await expect(trail(page)).not.toContainText(SAMPLE_WORLD_THREADS.refund);
    await expect(page.locator('[data-chat]')).toHaveCount(5);
    await expect(page.getByRole('searchbox', { name: 'Search chats' })).toBeEnabled();
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'can’t load',
      source: SOURCE,
    });

    await area.getByRole('button', { name: 'Back to chats' }).click();
    await expect(page).toHaveURL(/\/chats$/);
  });
});

const HOST_REQUESTS = /\/(v1|bureau|api|host)\//;
const REFUSED = /net::ERR_CONNECTION_REFUSED/;

test.describe('an open chat while the server does not answer (16y, 18e)', () => {
  test('keeps the list and the transcript at full contrast and turns off only what changes something: Deny, Approve, Retry and New chat, with the reason as their description', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: REFUSED,
      reason: 'the test takes the page’s network away on purpose',
    });
    // Provider connected, so the composer is live: the person's follow-up, sent while the approval
    // waits, is the message that was not sent (frame g).
    await connectProvider(page);
    // The page loads at 10:44 AM, two minutes before the sample "now".
    await page.clock.install({ time: SAMPLE_NOW_MILLISECONDS - 2 * 60_000 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);
    await expect(page.locator('[data-approval-decision]')).toBeVisible();
    // The connection drops as the message goes out, so it is the transport that fails and the row
    // says "Not sent" (the page names a transport failure there, not in an alert of its own).
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
      if (body.method === 'bureau.contexts.input') await route.abort('connectionrefused');
      else await route.fallback();
    });
    const followUp = 'Also look up order 4398, the same carrier.';
    const composerBox = page.getByRole('textbox', { name: /^Message/ });
    await composerBox.fill(followUp);
    await composerBox.press('Enter');
    // While the approval waits the follow-up waits in Up next (COR-2284); Send now instead hands it
    // to the run, which is the request the dropped connection fails.
    const upNext = page.locator('[data-chat-follow-up-drawer]');
    await expect(upNext).toContainText(followUp);
    await upNext.getByRole('button', { name: 'Send now instead' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Not sent' })).toBeVisible();

    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 500);
    await page.route(HOST_REQUESTS, (route) => route.abort('connectionrefused'));
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    const banner = page.getByRole('region', { name: 'Connection problem' });
    await expect(banner).toBeVisible();
    // The probes wait 1 s, then 2 s, then 4 s: the third attempt is 4 s away.
    await page.clock.runFor(1_000);
    await expect(banner).toContainText('Retrying in 2 s (attempt 2 of 8)');
    await page.clock.runFor(2_000);
    await expect(banner).toContainText(
      'Can’t reach the Interborough server. Showing what loaded as of 10:44 AM CST. Changes are off until it’s back. Retrying in 4 s (attempt 3 of 8).',
    );
    // The banner is the one account of it: the chat draws none of its own for a dropped stream.
    await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);

    // Full contrast: nothing of the list or the transcript is dimmed.
    expect(await opacityOf(page.locator('[data-chat]'))).toBe(1);
    expect(await opacityOf(conversationArea(page).getByText('Please refund order 4472'))).toBe(1);
    const approval = page.locator('[data-approval-decision]');
    expect(await opacityOf(approval.getByRole('heading', { level: 4 }))).toBe(1);

    // Only controls that change things are inert: aria-disabled, still focusable, each with its
    // reason as its description.
    const reason = 'Approving is off until Interborough is reachable';
    await expect(approval).toContainText(reason);
    for (const name of ['Deny', 'Approve']) {
      const button = approval.getByRole('button', { name });
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).not.toHaveAttribute('disabled', /.*/);
      await expect(button).toHaveAccessibleDescription(reason);
      await button.focus();
      await expect(button).toBeFocused();
    }
    // The message that was not sent keeps its Retry in the details beside "Not sent", off while the
    // server does not answer, with the reason beside it.
    await page.getByRole('button', { name: 'Not sent: details' }).click();
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    // Like Deny and Approve: aria-disabled, focusable, and described by the reason beside it.
    await expect(retry).toHaveAttribute('aria-disabled', 'true');
    await expect(retry).not.toHaveAttribute('disabled', /.*/);
    await expect(retry).toHaveAccessibleDescription('Retries when you’re back online.');
    await retry.focus();
    await expect(retry).toBeFocused();
    await expect(
      page
        .getByRole('dialog')
        .or(page.getByRole('group'))
        .filter({ hasText: 'Retries when you’re back online.' })
        .first(),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    const newChat = page.getByRole('link', { name: 'New chat' }).first();
    await expect(newChat).toHaveAttribute('aria-disabled', 'true');
    await newChat.focus();
    await expect(newChat).toBeFocused();
    // What changes nothing stays live: the Input disclosure, a note, the list's search and links.
    await expect(approval.getByRole('button', { name: /^Input/ })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(approval.getByRole('button', { name: 'Add a note' })).toBeEnabled();
    await expect(page.getByRole('searchbox', { name: 'Search chats' })).toBeEnabled();
    await expect(banner.getByRole('button', { name: 'Retry now' })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'server unreachable',
      source: SOURCE,
    });
  });
});

/**
 * The stream of a run that is going, held open as a live run's is: the page reads it through
 * `fetch`, so a run the sample world does not hold can be joined. Installed before the page loads,
 * it answers the thread's attach once `window.__continuationFrames` holds the frames to send.
 */
async function holdContinuationStream(page: Page, thread: string): Promise<void> {
  await page.addInitScript((threadId: string) => {
    const original = window.fetch.bind(window);
    const holding = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const frames = (window as unknown as { __continuationFrames?: unknown[] })
        .__continuationFrames;
      if (frames === undefined || !url.includes(`/ag-ui/threads/${threadId}/run`)) {
        return original(input, init);
      }
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const frame of frames) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
            }
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    };
    window.fetch = Object.assign(holding, { preconnect: window.fetch.preconnect });
  }, thread);
}

test.describe('an open chat whose approval is answered in Reviews (18i, 18j)', () => {
  test('collapses the approval in place to who decided, where and when, says so once to a screen reader, and offers no Deny or Approve, then joins the run that continues it', async ({
    page,
    request,
  }) => {
    await connectProvider(page);
    await holdContinuationStream(page, SAMPLE_WORLD_THREADS.refund);
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);
    const waiting = page.locator('[data-approval-decision]');
    await expect(waiting).toBeVisible();
    const asked = await waiting.getByRole('heading', { level: 4 }).innerText();
    const question = asked.trim();
    expect(question).toBe('Refund order 4471 for $42.00?');

    // The review the page shows, from the Bureau, so the answer below is the same call's.
    const listed = await request.post(`${E2E_SHOWCASE_URL}/bureau/jsonrpc`, {
      data: { jsonrpc: '2.0', id: 1, method: 'bureau.reviews.list', params: {} },
    });
    const reviews = ((await listed.json()) as { result: { reviews: ReviewRow[] } }).result.reviews;
    const callId = reviews.find((review) => review.sessionId === SAMPLE_WORLD_THREADS.refund)
      ?.approval?.callId;
    expect(callId).toBeDefined();

    // Reviews answers it: the Bureau no longer lists it, and the thread says who decided and when.
    // Both are the Bureau's own answers for a world where the person approved it at 10:46 AM.
    await answerOperation(page, 'bureau.reviews.list', (route) =>
      route.fulfill({ json: { jsonrpc: '2.0', id: 1, result: { reviews: [] } } }),
    );
    // The chat's runs: none going until the Bureau starts the run that continues the chat. Once it
    // has, the chat is running wherever the Bureau says what it is doing (`activity`).
    let continuing = false;
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        method?: string;
        params?: { contextId?: string; activity?: string };
      };
      if (
        continuing &&
        body.method === 'bureau.contexts.get' &&
        body.params?.contextId === SAMPLE_WORLD_THREADS.refund
      ) {
        const response = await route.fetch();
        const read = (await response.json()) as { result: Record<string, unknown> };
        await route.fulfill({
          response,
          json: { ...read, result: { ...read.result, activity: 'running' } },
        });
        return;
      }
      if (continuing && body.method === 'bureau.contexts.list') {
        const response = await route.fetch();
        const page = (await response.json()) as {
          result: { contexts: Array<{ id: string; activity: string }> };
        };
        const running = page.result.contexts
          .filter(
            (context) =>
              context.id !== SAMPLE_WORLD_THREADS.refund ||
              body.params?.activity !== 'awaiting-input',
          )
          .map((context) =>
            context.id === SAMPLE_WORLD_THREADS.refund
              ? { ...context, activity: 'running' }
              : context,
          );
        await route.fulfill({
          response,
          json: { ...page, result: { ...page.result, contexts: running } },
        });
        return;
      }
      if (
        body.method !== 'bureau.tasks.list' ||
        body.params?.contextId !== SAMPLE_WORLD_THREADS.refund ||
        !continuing
      ) {
        await route.fallback();
        return;
      }
      const at = new Date(SAMPLE_NOW_MILLISECONDS).toISOString();
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id: 1,
          result: {
            tasks: [
              {
                id: 'run-refund-continued',
                contextId: SAMPLE_WORLD_THREADS.refund,
                agentName: 'tool-runner',
                owner: 'anonymous:local',
                actor: null,
                kind: 'chat',
                origin: { kind: 'chat' },
                status: 'working',
                finishReason: null,
                statusMessage: null,
                createdAt: at,
                updatedAt: at,
                cleanup: null,
                openWaits: [],
                wakeAt: null,
              },
            ],
            nextPageToken: null,
          },
        },
      });
    });
    let decidedMessages: unknown[] = [];
    await page.route('**/ag-ui/threads/*/messages', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { messages: Array<Record<string, unknown>> };
      // The approved refund of order 4472 is the same tool's outcome, as the Bureau wrote it when
      // the person approved it at 10:33 AM: its row, for the one the person approves at 10:46 AM.
      const approved = body.messages.find(
        (message) =>
          message['role'] === 'tool' &&
          message['toolCallId'] !== callId &&
          JSON.stringify(message).includes('approvalDecision'),
      );
      expect(approved, 'the sample world holds the approved 4472 refund').toBeDefined();
      const outcome = JSON.parse(
        JSON.stringify(approved)
          .replaceAll('4472', '4471')
          .replaceAll('1850', '4200')
          .replaceAll(
            /"decidedAt":"[^"]+"/g,
            `"decidedAt":"${new Date(SAMPLE_NOW_MILLISECONDS).toISOString()}"`,
          ),
      ) as Record<string, unknown>;
      decidedMessages = body.messages.map((message) =>
        message['role'] === 'tool' && message['toolCallId'] === callId
          ? {
              ...outcome,
              id: message['id'],
              toolCallId: callId,
              metadata: {
                ...(outcome['metadata'] as Record<string, unknown>),
                approvalDecision: {
                  ...(outcome['metadata'] as { approvalDecision?: object }).approvalDecision,
                  asked: 'Refund order 4471 for $42.00',
                },
              },
            }
          : message,
      );
      await route.fulfill({ response, json: { ...body, messages: decidedMessages } });
    });
    await page.route('**/ag-ui/threads/*/run', (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' })}\n\n`,
      }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

    const decided = page.locator('.cinder-approval-card--row').filter({ hasText: question });
    await expect(decided).toBeVisible();
    await expect(decided.locator('.cinder-approval-card__outcome')).toContainText(
      /Approved by you in Reviews,\s*10:46 AM/,
    );
    await expect(decided.getByRole('button', { name: 'Deny' })).toHaveCount(0);
    await expect(decided.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(page.locator('[data-approval-decision]')).toHaveCount(0);
    // The row collapses to a check, the question and the decision: no tool line and no Input.
    // The card holds the question twice in its text: once in an aria-hidden screen-reader-only
    // span that only matchers read, and once as the heading a person sees.
    await expect(decided).toHaveText(
      /^\s*(?:Refund order 4471 for \$42\.00\?\s*){2}Approved by you in Reviews,\s*10:46 AM\s*$/,
    );
    await expect(decided.getByRole('heading')).toHaveText('Refund order 4471 for $42.00?');
    await expect(decided.locator('.cinder-approval-card__decided-glyph')).toHaveAttribute(
      'data-cinder-tone',
      'success',
    );
    // The rail row says the same in its own words, as the run the decision continues: from the
    // moment it is told, the Bureau is starting that run.
    await expect(
      conversationArea(page)
        .locator('.cinder-tool-call-rail__item[data-cinder-status="running"]')
        .filter({ hasText: '4471' }),
    ).toContainText(/Approved by you in Reviews 10:46 AM, running…/);
    // A polite live region says it once.
    const live = page.getByTestId('chat-decision-announcement');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText('Approved in Reviews. Refund order 4471 for $42.00.');
    // The decision is told before the Bureau's continuing run is going, so the chat has not
    // joined it yet: this is the moment between frame r's two halves, not the frame.
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'answered in Reviews, run not joined yet',
      source: SOURCE,
    });

    // The decision was the last the run waited on, so the Bureau continues the chat with a run of
    // its own (`bureau.reviews.resolve`), which starts just after the decision is told. Once the
    // chat's runs show it, the page joins it: Running, Stop in Send's place, and a message steers.
    continuing = true;
    await page.evaluate(
      ({ thread, messages }) => {
        (window as unknown as { __continuationFrames?: unknown[] }).__continuationFrames = [
          { type: 'RUN_STARTED', threadId: thread, runId: 'run-refund-continued' },
          { type: 'MESSAGES_SNAPSHOT', messages },
        ];
        window.dispatchEvent(new Event('visibilitychange'));
      },
      { thread: SAMPLE_WORLD_THREADS.refund, messages: decidedMessages },
    );
    const composer = page.getByRole('form', { name: 'Chat message composer' });
    await expect(composer.getByRole('button', { name: 'Stop generating' })).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Send message' })).toHaveCount(0);
    await expect(conversationArea(page).locator('.chat-input-status')).toHaveText(
      'A message now steers the run.',
    );
    await expect(conversationArea(page).getByRole('img', { name: 'Running' })).toBeVisible();
    // The decision stays as it was, and is not told again.
    await expect(decided.locator('.cinder-approval-card__outcome')).toContainText(
      /Approved by you in Reviews,\s*10:46 AM/,
    );
    await expect(live).toHaveText('Approved in Reviews. Refund order 4471 for $42.00.');
    // While the continuing run is going the rail row says so in place of the result (18i), and
    // the chat's status and its row in the list say Running too.
    await expect(
      conversationArea(page)
        .locator('.cinder-tool-call-rail__item[data-cinder-status="running"]')
        .filter({ hasText: '4471' }),
    ).toContainText(/Approved by you in Reviews 10:46 AM, running…/);
    await expect(conversationArea(page).getByTestId('chat-header')).toContainText('Running');
    // The transcript holds the earlier 4472 turn above this one. The window is tall enough for both
    // turns and rests at the top, so the first reply is read whole and not from its last line.
    await page.setViewportSize({ width: 1280, height: 1400 });
    await conversationArea(page)
      .getByText('Please refund order 4471, it arrived damaged.', { exact: true })
      .first()
      .evaluate((element) => {
        for (let node = element.parentElement; node !== null; node = node.parentElement) {
          if (node.scrollHeight > node.clientHeight) node.scrollTop = 0;
        }
      });
    await expect(
      conversationArea(page).getByText('You approved it. Refunded $18.50'),
    ).toBeInViewport();
    for (const state of ['approved in Reviews', 'running after Reviews']) {
      await captureForDesignReview(page, { route: '/chats/:chat', state, source: SOURCE });
    }
  });
});

test.describe('an open chat whose approval was denied with a note (18h)', () => {
  const NOTE = 'Check the carrier’s claim first.';
  const THREAD = 'sample-chat-denied-refund';
  const TITLE = 'Please refund order 4398, it arrived damaged.';
  const at = (time: string) => `2026-11-02T${time}.000Z`;
  const stamped = (time: string) => ({ 'conversationalist:createdAt': at(time) });

  /**
   * What the Bureau answers for a chat in which the person denied the refund of order 4398 and left
   * a note, and the agent then answered from it: the thread holds the denial's record (who, when and
   * the note) on the call's outcome row, and the reply is the agent's own.
   */
  async function serveDeniedChat(page: Page, request: APIRequestContext): Promise<void> {
    // The chat is the refund chat's own kind: the same agent, model and settings the Bureau holds
    // for it, with this chat's identity and times.
    const read = await request.post(`${E2E_SHOWCASE_URL}/bureau/jsonrpc`, {
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'bureau.contexts.get',
        params: { contextId: SAMPLE_WORLD_THREADS.refund },
      },
    });
    const real = ((await read.json()) as { result: Record<string, unknown> }).result;
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        method?: string;
        id?: unknown;
        params?: { contextId?: string };
      };
      if (body.method === 'bureau.contexts.get' && body.params?.contextId === THREAD) {
        await route.fulfill({
          json: {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              ...real,
              id: THREAD,
              title: TITLE,
              lastMessagePreview: 'I haven’t issued it.',
              messageCount: 6,
              createdAt: at('16:38:00'),
              updatedAt: at('16:40:00'),
              activity: 'idle',
            },
          },
        });
        return;
      }
      await route.fallback();
    });
    await page.route(`**/ag-ui/threads/${THREAD}/messages`, (route) =>
      route.fulfill({
        json: {
          threadId: THREAD,
          messages: [
            { id: 'u1', role: 'user', content: TITLE, metadata: stamped('16:38:00') },
            {
              id: 'a1',
              role: 'assistant',
              content: '',
              metadata: stamped('16:38:01'),
              toolCalls: [
                {
                  id: 'call-lookup',
                  type: 'function',
                  function: { name: 'lookup-order', arguments: '{"orderId":4398}' },
                },
                {
                  id: 'call-refund',
                  type: 'function',
                  function: {
                    name: 'issue-refund',
                    arguments: '{"orderId":4398,"amount":"$27.25","reason":"Arrived damaged"}',
                  },
                },
              ],
            },
            {
              id: 'r1',
              role: 'tool',
              toolCallId: 'call-lookup',
              content: JSON.stringify({
                amount: '$27.25',
                delivered: 'Friday',
                flagged: 'damaged',
              }),
              metadata: stamped('16:38:02'),
            },
            {
              id: 'r2',
              role: 'tool',
              toolCallId: 'call-refund',
              content: `Tool call denied: ${NOTE}`,
              error: `Tool call denied: ${NOTE}`,
              metadata: {
                ...stamped('16:40:00'),
                approvalDecision: {
                  decision: 'deny',
                  decidedBy: 'anonymous:local',
                  decidedAt: at('16:40:00'),
                  reason: NOTE,
                  asked: 'Refund order 4398 for $27.25',
                },
              },
            },
            {
              // The Bureau names a run's reply `<run>:step:<n>`.
              id: 'sample-run-denied-refund:step:2',
              role: 'assistant',
              content: `You denied this refund and said: “${NOTE}” I haven’t issued it, and I’ll wait for the claim before trying again.`,
              metadata: {
                ...stamped('16:40:05'),
                'bureau:replyModel': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
              },
            },
          ],
        },
      }),
    );
    await page.route(`**/ag-ui/threads/${THREAD}/run`, (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' })}\n\n`,
      }),
    );
  }

  test('keeps the denial in the transcript as a neutral decision with the note, and the agent’s reply uses it, beside the normal live composer', async ({
    page,
    request,
  }) => {
    await connectProvider(page);
    await serveDeniedChat(page, request);
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/chats/${THREAD}`);

    const denied = page
      .locator('.cinder-approval-card--row')
      .filter({ hasText: 'Refund order 4398' });
    await expect(denied).toBeVisible();
    await expect(denied.locator('.cinder-approval-card__outcome')).toContainText(
      /Denied by you,\s*10:40 AM/,
    );
    await expect(denied.locator('.cinder-approval-card__decision-note')).toContainText(NOTE);
    await expect(
      conversationArea(page).locator('.cinder-tool-call-rail__item[data-cinder-status="denied"]'),
    ).toContainText('Denied by you 10:40 AM');
    await expect(
      conversationArea(page).getByText(
        `You denied this refund and said: “${NOTE}” I haven’t issued it, and I’ll wait for the claim before trying again.`,
      ),
    ).toBeVisible();
    // The reply's line reads the time, then the names of Copy, Quote message and Regenerate (the
    // latest reply offers all three, each an icon-only button), then the model the host adds
    // (COR-2281).
    const details = conversationArea(page)
      .getByRole('group', { name: 'Message details' })
      .filter({ hasText: /^\s*10:40 AM\s*Copy\s*Quote message\s*Regenerate\s*Claude Sonnet 5\.5/ });
    await expect(details).toHaveCount(1);
    await expect(details.getByRole('button', { name: 'Copy' })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Quote message' })).toBeVisible();
    // The composer is the normal live one with Send, and the chat is Done.
    const composer = conversationArea(page).getByRole('textbox', { name: 'Message' });
    await expect(composer).toBeEnabled();
    await composer.fill('Thanks.');
    await expect(
      conversationArea(page).getByRole('button', { name: 'Send message' }),
    ).toBeEnabled();
    await expect(page.getByRole('heading', { level: 1, name: TITLE }).locator('..')).toContainText(
      'Done',
    );
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'denied approval and note',
      source: SOURCE,
    });
  });
});

/** The part of a review row the test reads. */
interface ReviewRow {
  readonly sessionId?: string;
  readonly approval?: { readonly callId?: string };
}
