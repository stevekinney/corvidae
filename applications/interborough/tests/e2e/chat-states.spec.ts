/**
 * The Chat page states of the ChatStates board on the sample world (`fixtures/sample-world-seed.ts`,
 * the showcase host) at the browser's sample clock, Monday, Nov 2, 10:46 AM Central time (COR-2016,
 * design rows 19a, 19b, 19c, 19e, 19f, 19h, 19k, 19o, 19p, 19u, 20f and 20h). A state the sample
 * world holds is opened as it stands: the chat the server ended (frame a), the refund chat with no
 * provider (frame b) and a chat that does not exist (frame g). A captioned state it does not hold is
 * made by answering the Bureau's own operations with what a different world would answer
 * (`fixtures/chat-states.ts`): the Release helper chat whose plugin is disabled (frames c and i), a
 * reply that failed partway (frame f), and a turn that ended on a tool call (frame j). Frames d and e
 * are a reference card on the board; loading the chat and the server not answering are drawn once, in
 * `chat-page.spec.ts` (its frames e, g and m), so the two copies cannot drift. Each frame is captured
 * for the design review under its own name.
 */
import type { Locator, Page } from '@playwright/test';

import {
  billingThreadWithPartialReply,
  ENDED_ON_TOOL_CALL_THREAD,
  ENDED_PARTIAL_REPLY,
  FAILED_PARTWAY_REPLY,
  HELD_BY_PLUGIN_REASON,
  HELD_BY_PLUGIN_TITLE,
  messagesOf,
  REFUND_TITLE,
  tasksOf,
} from '../../fixtures/chat-states.ts';
import { SAMPLE_NOW_MILLISECONDS, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { SAMPLE_WORLD_THREADS } from '../../fixtures/sample-world-records.ts';
import { connectProvider, open, openStatesChat } from './chat-states-support.ts';
import {
  captureForDesignReview,
  captureForDesignReviewWithPhone,
} from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'chat-states.spec.ts';

/**
 * Ten seconds past the sample "now". The Release helper chat's approval was asked at 10:34 AM, and
 * the board says it was 12 minutes ago at 10:46: counted to the minute, as the card counts, that
 * takes the clock just past 10:46:00.
 */
const HELD_NOW = SAMPLE_NOW_MILLISECONDS + 10_000;

/** Gives the sample world's billing chat the part of its reply that arrived before the restart. */
async function keepPartialReply(page: Page): Promise<void> {
  await page.route(`**/ag-ui/threads/${SAMPLE_WORLD_THREADS.billing}/messages`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      threadId: string;
      messages: Record<string, unknown>[];
    };
    await route.fulfill({
      response,
      json: { ...body, messages: billingThreadWithPartialReply(body.messages) },
    });
  });
}

const trail = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const header = (page: Page) => page.getByTestId('chat-header');
const transcript = (page: Page) => page.getByRole('region', { name: 'Chat conversation' });
const blockedRow = (page: Page) => page.locator('[data-chat-composer-status="blocked"]');
const rail = (page: Page) => page.locator('.cinder-tool-call-rail');
const railRow = (page: Page, tool: string): Locator =>
  rail(page).locator('[data-cinder-tool-call-row]').filter({ hasText: tool });

/**
 * The status word beside a chat's title, and the tone of the Badge it is drawn as (COR-2438: a
 * Badge, as on the tool-call row; `dot` keeps its name for the tone).
 */
async function statusOf(page: Page): Promise<{ word: string; dot: string | null }> {
  const heading = header(page);
  const dot = heading
    .locator('.cinder-page-header__status .cinder-badge')
    .filter({ visible: true })
    .first();
  const shown = await heading.innerText();
  const text = shown.replace(/\s+/g, ' ');
  return {
    word:
      ['Waiting on you', 'Running', 'Failed', 'Ended', 'Done'].find((word) =>
        text.includes(word),
      ) ?? '',
    dot: (await dot.count()) === 0 ? null : await dot.getAttribute('data-cinder-variant'),
  };
}

/** The opacity of `locator`, which must be on the page. */
const opacityOf = (locator: Locator): Promise<number> =>
  locator.first().evaluate((element) => Number(getComputedStyle(element).opacity));

/** The shell's top bar as the board copies it over every frame (19a). */
async function expectTopBar(page: Page): Promise<void> {
  const banner = page.getByRole('banner');
  await expect(trail(page).getByRole('link', { name: 'Chat' })).toBeVisible();
  await expect(banner.getByRole('button', { name: /^Search everything/ })).toContainText('⌘');
  await expect(banner.getByRole('button', { name: /^Notifications/ })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Quick settings' })).toBeVisible();
}

test.describe('Chat ended by a restart (frame a: 19a, 19b, 19c, 19e)', () => {
  test('keeps the conversation readable under a heading that says Ended with a neutral dot, and a ⋯ menu (19a, 19b)', async ({
    page,
  }) => {
    await keepPartialReply(page);
    await open(page, `/chats/${SAMPLE_WORLD_THREADS.billing}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(transcript(page).getByText(ENDED_PARTIAL_REPLY)).toBeVisible();

    await expectTopBar(page);
    await expect(
      trail(page).getByRole('button', { name: 'Rename the billing tables' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Rename the billing tables' }),
    ).toBeVisible();
    // Ended is a chat-only word with a neutral dot.
    expect(await statusOf(page)).toEqual({ word: 'Ended', dot: 'neutral' });
    await expect(header(page).getByRole('button', { name: 'More actions' })).toBeVisible();
    // A notice that stops the chat is one warning tone, and nothing is drawn as a banner.
    await expect(page.locator('.cinder-banner')).toHaveCount(0);
    // The conversation stays at full contrast; only what the person can do changes.
    expect(await opacityOf(transcript(page))).toBe(1);
  });

  test('keeps the person’s message with Branch and Copy, the partial reply, and says why under it with an info glyph (19c)', async ({
    page,
  }) => {
    await keepPartialReply(page);
    await open(page, `/chats/${SAMPLE_WORLD_THREADS.billing}`);
    const conversation = transcript(page);
    await expect(conversation.getByText(ENDED_PARTIAL_REPLY)).toBeVisible();

    const message = conversation.locator('[data-role="user"], .chat-message--user').first();
    await expect(message).toContainText('Rename the billing tables');
    await expect(message).toContainText('Oct 29, 11:04 AM');
    await expect(message.getByRole('button', { name: /Branch/ })).toBeVisible();
    await expect(message.getByRole('button', { name: /Copy/ })).toBeVisible();

    const line = conversation.locator('.chat-note[data-notice]');
    await expect(line).toHaveText(
      'The server restarted before this reply finished. What arrived is kept; the chat can’t continue.',
    );
    await expect(line.locator('svg.lucide-info')).toBeVisible();
    // A reply the Bureau recorded no time for is not dated by the moment it was read: no time under
    // it and no band for today above the Oct 29 message (19c).
    await expect(
      conversation.locator('article', { hasText: ENDED_PARTIAL_REPLY }).locator('time'),
    ).toHaveCount(0);
    await expect(conversation).not.toContainText(/today/i);
    await expect(conversation).not.toContainText('November 7');
    // Muted like the times, not the danger red of a failure.
    const colors = await Promise.all([
      line.evaluate((element) => getComputedStyle(element).color),
      message.getByText('Oct 29, 11:04 AM').evaluate((element) => getComputedStyle(element).color),
    ]);
    expect(colors[0]).toBe(colors[1]);
    // It replaces the plain line the canceled run left, and nothing is offered to retry.
    await expect(conversation.locator('.chat-note')).toHaveCount(1);
    await expect(conversation).not.toContainText('The run was stopped.');
    await expect(line.getByRole('button')).toHaveCount(0);
    // It follows the reply that arrived, in reading order.
    const order = await conversation.evaluate((root, reply) => {
      const text = root.textContent ?? '';
      return { reply: text.indexOf(reply), notice: text.indexOf('The server restarted') };
    }, ENDED_PARTIAL_REPLY);
    expect(order.reply).toBeGreaterThanOrEqual(0);
    expect(order.notice).toBeGreaterThan(order.reply);

    // The one blocked row says the chat has ended, with New chat; there is no text box.
    await expect(blockedRow(page)).toContainText(
      'This chat has ended. The server stopped it when it restarted.',
    );
    await expect(blockedRow(page).getByRole('link', { name: 'New chat' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Message/ })).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'ended by a restart',
      source: SOURCE,
    });
  });

  test('expires no approval: a restart ends a chat’s run, not a review, and “Expired” belongs to the Reviews page (19e)', async ({
    page,
  }) => {
    await keepPartialReply(page);
    await open(page, `/chats/${SAMPLE_WORLD_THREADS.billing}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(transcript(page).getByText(ENDED_PARTIAL_REPLY)).toBeVisible();
    await expect(page.locator('.cinder-approval-card')).toHaveCount(0);
    await expect(page.getByText('Expired')).toHaveCount(0);
    // The refund chat that was only waiting on a review is not ended by the restart: its review
    // stays waiting and answerable (frame i draws it held back by a plugin instead).
    await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);
    const approval = page.locator('[data-approval-decision]');
    await expect(approval.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
    await expect(header(page)).not.toContainText('Waiting on you');
    const waiting = transcript(page)
      .getByText('Waiting on you', { exact: true })
      .filter({ visible: true });
    await expect(waiting).toHaveCount(1);
  });
});

test('shows one waiting status in the refund conversation on a phone (COR-2451)', async ({
  page,
}) => {
  await connectProvider(page);
  await page.clock.setFixedTime(SAMPLE_NOW_MILLISECONDS);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);
  await expect(page.locator('[data-approval-decision]')).toBeVisible();

  const status = transcript(page)
    .getByText('Waiting on you', { exact: true })
    .filter({ visible: true });
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 640 });
    await expect(status).toHaveCount(1);
  }

  await captureForDesignReview(page, {
    route: '/chats/:chat',
    state: 'waiting once in the refund conversation on a phone',
    source: SOURCE,
  });
});

test.describe('No model provider connected (frame b: 19f, 19h)', () => {
  test('shows the refund chat waiting on you, with its message, its Lookup order row and its reply (19f)', async ({
    page,
  }) => {
    await open(page, `/chats/${SAMPLE_WORLD_THREADS.refund}`);
    await expect(page.locator('[data-approval-decision]')).toBeVisible();

    await expectTopBar(page);
    await expect(trail(page).getByRole('button', { name: /^Refund order 4471/ })).toBeVisible();
    const waitingStatus = transcript(page)
      .getByText('Waiting on you', { exact: true })
      .filter({ visible: true });
    await expect(waitingStatus).toHaveCount(1);
    await expect(waitingStatus).toBeVisible();

    const conversation = transcript(page);
    const message = conversation.getByText(REFUND_TITLE).last();
    await expect(message).toBeVisible();
    const user = conversation.locator('[data-role="user"], .chat-message--user').last();
    await expect(user.getByRole('button', { name: /Copy/ })).toBeVisible();
    const lookup = railRow(page, 'Lookup order').last();
    await expect(lookup).toContainText('4471');
    // Lookup order says what it found in words, as the board draws it, and took 0.4s.
    await expect(lookup).toContainText('$42.00, delivered Monday, flagged damaged');
    await expect(lookup).toContainText('0.4s');
    // The reply is stamped with when it was written and, after Copy and Quote (COR-2281), the
    // model that wrote it.
    await expect(
      conversation.getByRole('group', { name: 'Message details' }).filter({
        hasText: /^\s*10:42 AM\s*Copy\s*Quote message\s*Regenerate\s*Claude Sonnet 5\.5/,
      }),
    ).toBeVisible();
    // The composer is the one blocked row, not a banner.
    // Chat keeps the conversation and replaces only the composer (COR-2285 V4).
    await expect(blockedRow(page)).toContainText('Connect a model provider');
    await expect(blockedRow(page).getByRole('button', { name: 'Connect provider' })).toContainClass(
      'button-variant-primary',
    );
    await expect(page.locator('[data-chat-availability]')).toHaveCount(0);
    await expect(page.locator('.cinder-banner')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'no model provider',
      source: SOURCE,
    });
  });

  test('keeps Approve and Deny enabled, queues nothing, and leaves the Connect prompt to the blocked row (19h, COR-2327 N4)', async ({
    page,
  }) => {
    await open(page, `/chats/${SAMPLE_WORLD_THREADS.refund}`);
    const approval = page.locator('[data-approval-decision]');
    await expect(approval).toBeVisible();
    for (const name of ['Approve', 'Deny']) {
      const button = approval.getByRole('button', { name });
      await expect(button).toBeEnabled();
      await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    }
    // The blocked row in the composer's place carries Connect a model provider and its action, so
    // the approval says nothing more about a provider.
    await expect(page.locator('[data-chat-composer-status="blocked"]')).toContainText(
      'Connect a model provider',
    );
    await expect(page.locator('.weft-chat-approval__provider-note')).toHaveCount(0);
    // Nothing pretends to be pending: no queued message, no "Sending" line.
    await expect(page.getByText(/^Queued/)).toHaveCount(0);
    await expect(page.getByText(/Sending…|Sending resumes/)).toHaveCount(0);
  });
});

test.describe('Agent’s plugin is disabled (frame c: 19k)', () => {
  test('shows a Release helper approval held by its plugin, its message and its List changes row, and draws no banner (19k)', async ({
    page,
    request,
  }) => {
    await openStatesChat(page, request, 'held-by-plugin', HELD_NOW);
    await expect(page.getByText(HELD_BY_PLUGIN_REASON)).toBeVisible();

    await expectTopBar(page);
    await expect(trail(page).getByRole('button', { name: HELD_BY_PLUGIN_TITLE })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: HELD_BY_PLUGIN_TITLE })).toBeVisible();
    expect(await statusOf(page)).toEqual({ word: '', dot: null });
    await expect(transcript(page).locator('.cinder-approval-card__state-word')).toHaveText(
      'Unavailable',
    );

    const user = transcript(page).locator('[data-role="user"], .chat-message--user').first();
    await expect(user).toContainText(HELD_BY_PLUGIN_TITLE);
    await expect(user).toContainText('10:34 AM');
    await expect(user.getByRole('button', { name: /Branch/ })).toBeVisible();
    await expect(user.getByRole('button', { name: /Copy/ })).toBeVisible();
    const row = railRow(page, 'List changes');
    await expect(row).toContainText('2.4');
    await expect(row).toContainText('→ 12 changes since 2.3');
    await expect(row).toContainText('0.8s');
    // No banner: the composer’s blocked row already names the agent and the plugin, once.
    await expect(page.locator('.cinder-banner')).toHaveCount(0);
    await expect(blockedRow(page)).toContainText(
      'Release helper isn’t available. Enable the Demo plugin to continue.',
    );
    await expect(
      blockedRow(page).getByRole('button', { name: 'Enable and restart' }),
    ).toBeVisible();
    await expect(page.getByText('Release helper isn’t available')).toHaveCount(1);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'agent’s plugin is disabled',
      source: SOURCE,
    });
  });
});

test.describe('Restarting after Enable and restart (frame i: 20f)', () => {
  test('keeps the List changes row and the Unavailable approval readable at full contrast (20f)', async ({
    page,
    request,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: /net::ERR_CONNECTION_FAILED/,
      reason: 'the test holds the host down once it is asked to restart, so its plugin reads fail',
    });
    // The host is asked to restart and answers no more, so the chat reads what it knew. The
    // restart request is held first, so the banner for a restart being asked for can be read.
    let down = false;
    let releaseRestart: () => void = () => undefined;
    const restartHeld = new Promise<void>((resolve) => {
      releaseRestart = resolve;
    });
    await page.route('**/host/plugins/*', (route) =>
      route.fulfill({
        json: { plugin: 'demo', enabled: true, configuration: {}, restartRequired: true },
      }),
    );
    await page.route('**/host/plugins', async (route) => {
      if (down) {
        await route.abort('connectionfailed');
        return;
      }
      await route.fallback();
    });
    await page.route('**/host/restart', async (route) => {
      if (route.request().method() === 'POST') {
        await restartHeld;
        down = true;
        await route.fulfill({ status: 202, json: { restarting: true } });
        return;
      }
      await route.fulfill({
        json: { available: true, launch: { command: 'bun run start', directory: '/home' } },
      });
    });
    await openStatesChat(page, request, 'held-by-plugin', HELD_NOW);
    const restartBlocked = blockedRow(page).getByRole('button', { name: 'Enable and restart' });
    await restartBlocked.click();
    await page
      .getByRole('dialog', { name: /^Enable the Demo plugin and restart/ })
      .getByRole('button', { name: 'Enable and restart' })
      .click();
    await expect(
      blockedRow(page).getByText('Sending resumes when Interborough is back.'),
    ).toBeVisible();

    // The shared restarting banner sits above the heading with no action and no dismiss, and no
    // dialog takes the page over: the conversation is not covered, blurred or dimmed (20e, 20f).
    const banner = page.getByTestId('chat-restart-banner');
    await expect(banner).toHaveAttribute('data-cinder-preset', 'restarting');
    await expect(banner).toContainText(
      'Restarting Interborough. Your changes are saved. Running work picks up where it stopped; reviews stay waiting.',
    );
    await expect(banner.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const { bannerBox, headerBox } = await readBoxes(page, {
      bannerBox: banner,
      headerBox: page.getByTestId('chat-header'),
    });
    expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(headerBox.y);
    expect(
      await page.evaluate(() => document.querySelector('.weft-shell')?.hasAttribute('inert')),
    ).toBe(false);

    const conversation = transcript(page);
    const row = railRow(page, 'List changes');
    await expect(row).toContainText('0.8s');
    const card = conversation.locator('.cinder-approval-card');
    await expect(card).toHaveAttribute('data-cinder-layout', 'decision');
    await expect(card).toHaveAttribute('data-cinder-risk', 'medium');
    await expect(card).toContainText('Publish notes for 2.4?');
    await expect(card.locator('.cinder-approval-card__state-word')).toHaveText('Unavailable');
    await expect(card.locator('.cinder-approval-card__asker-source')).toHaveText(
      'Approval from Release helper',
    );
    await expect(card.locator('.cinder-approval-card__asker-time')).toHaveText('12 min ago');
    await expect(card).toContainText('Version 2.4');
    await expect(card).toContainText('Changes 12');
    await expect(card).toContainText(HELD_BY_PLUGIN_REASON);
    await expect(card.getByRole('button')).toHaveCount(0);
    // Full contrast: neither the row nor the held approval is dimmed.
    expect(await opacityOf(row)).toBe(1);
    expect(await opacityOf(card)).toBe(1);
    expect(await opacityOf(conversation)).toBe(1);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'restarting after enable and restart',
      source: SOURCE,
    });

    // Once the host stops answering the banner counts the attempts and offers Try again; the
    // conversation is still readable.
    releaseRestart();
    await expect(banner).toHaveAttribute('data-cinder-preset', 'reconnecting');
    await expect(banner).toContainText('Reconnecting');
    await expect(banner.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await opacityOf(card)).toBe(1);
  });
});

test.describe('Reply failed partway (frame f: 19p)', () => {
  test('is Failed with a red dot, keeps the message, the Lookup order row and the partial text, and says why with Retry (19p)', async ({
    page,
    request,
  }) => {
    await connectProvider(page);
    const { failedRunId } = await openStatesChat(page, request, 'failed-partway');
    await expect(transcript(page).getByText(FAILED_PARTWAY_REPLY)).toBeVisible();

    await expectTopBar(page);
    expect(await statusOf(page)).toEqual({ word: 'Failed', dot: 'danger' });
    // The chat's own row in the list says the same (19p): its latest run failed.
    await expect(
      page.locator('[data-chat]').filter({ hasText: '10:41 AM' }).filter({ hasText: 'Failed' }),
    ).toHaveCount(1);
    const user = transcript(page).locator('[data-role="user"], .chat-message--user').first();
    await expect(user).toContainText(REFUND_TITLE);
    await expect(user).toContainText('10:41 AM');
    const lookup = railRow(page, 'Lookup order');
    await expect(lookup).toContainText('4471');
    await expect(lookup).toContainText('0.4s');

    // The part that arrived stays until the person acts; the failure is a status line below it,
    // not agent speech, with Retry.
    const line = transcript(page).locator('.chat-turn-outcome[data-kind="failed"]');
    await expect(line).toContainText('This answer is incomplete.');
    await expect(line).toContainText(
      'The reply stopped partway: the model provider dropped the connection.',
    );
    await expect(line).toContainText('Retry keeps what was written so far.');
    await expect(line.getByRole('button', { name: 'Retry' })).toBeVisible();
    // This is a fine-pointer desktop Chat at the 1280px capture width. Attach keeps Cinder's
    // compact 28px face instead of flex-shrinking below the mouse target Cinder promises.
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(false);
    const attach = page.getByRole('button', { name: 'Attach file' });
    await expect(attach).toBeVisible();
    const { attach: attachBox } = await readBoxes(page, { attach });
    expect(attachBox.width).toBeGreaterThanOrEqual(24);
    expect(attachBox.height).toBeGreaterThanOrEqual(24);
    // COR-2533: the line leads to the run's explanation on the Run page.
    const explanation = line.getByRole('link', { name: 'Why it failed' });
    await expect(explanation).toHaveAttribute('href', /^\/runs\/.+#failure-explanation$/);
    await expect(page.locator('.weft-chat-strip')).toHaveCount(0);
    await expect(page.getByText('The agent did not answer', { exact: true })).toHaveCount(0);
    // The conversation stays live: a provider is connected, so the composer takes a message.
    await expect(page.getByRole('textbox', { name: /^Message/ })).toBeVisible();
    await expect(blockedRow(page)).toHaveCount(0);
    // At a phone too (375, and so 320): the line and its two actions wrap there (COR-2533).
    await captureForDesignReviewWithPhone(page, {
      route: '/chats/:chat',
      state: 'reply failed partway',
      source: SOURCE,
    });
    await explanation.click();
    await expect(page).toHaveURL(
      new RegExp(`/runs/${encodeURIComponent(failedRunId ?? '')}#failure-explanation$`),
    );
    await expect(page.locator('#failure-explanation')).toBeVisible();
  });

  test('at 320 by 640, Retry scrolls above the composer and receives its pointer (19p)', async ({
    page,
    request,
  }) => {
    await connectProvider(page);
    await openStatesChat(page, request, 'failed-partway');
    await page.setViewportSize({ width: 320, height: 640 });

    const timeline = transcript(page);
    const line = timeline.locator('.chat-turn-outcome[data-kind="failed"]');
    const retry = line.getByRole('button', { name: 'Retry' });
    const composer = page.locator('.chat-input-area');
    await expect(retry).toBeVisible();
    await timeline.evaluate(async (element) => {
      element.scrollTop = element.scrollHeight;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });

    const boxes = await readBoxes(page, { timeline, line, retry, composer });
    expect(boxes.line.y).toBeGreaterThanOrEqual(boxes.timeline.y);
    expect(boxes.line.y + boxes.line.height).toBeLessThanOrEqual(
      boxes.timeline.y + boxes.timeline.height,
    );
    expect(boxes.retry.y).toBeGreaterThanOrEqual(boxes.timeline.y);
    expect(boxes.retry.y + boxes.retry.height).toBeLessThanOrEqual(
      boxes.timeline.y + boxes.timeline.height,
    );
    expect(boxes.retry.y + boxes.retry.height).toBeLessThanOrEqual(boxes.composer.y + 1);
    expect(
      await retry.evaluate((button) => {
        const box = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      }),
    ).toBe(true);
    await retry.click({ trial: true });
  });
});

test.describe('Chat not found (frame g: 19u)', () => {
  test('reads Chat › Not found, draws no heading row, transcript or composer, and centres the full empty state (19u)', async ({
    page,
  }) => {
    await open(page, '/chats/no-such-chat-415b1fd8');
    const title = page.getByRole('heading', { level: 1, name: 'This chat doesn’t exist' });
    await expect(title).toBeVisible();

    await expectTopBar(page);
    await expect(trail(page).getByText('Not found', { exact: true })).toBeVisible();
    // Not the identifier, and not a button that would open details of a chat that is not there.
    await expect(trail(page)).not.toContainText('no-such-chat');
    await expect(trail(page).getByRole('button')).toHaveCount(0);
    await expect(header(page)).toHaveCount(0);
    await expect(page.locator('.weft-chat-surface')).toHaveCount(0);
    await expect(page.getByRole('textbox')).not.toBeVisible();

    await expect(page.getByText('It may have been deleted, or the link is wrong.')).toBeVisible();
    const create = page.getByRole('link', { name: 'New chat' }).last();
    await expect(create).toContainClass('button-variant-primary');
    const back = page.getByRole('link', { name: 'Back to chats' });
    await expect(back).toContainClass('button-variant-secondary');
    await expect(page.getByRole('button', { name: 'Search everything' }).last()).toBeVisible();

    // The state is centred in the pane that holds the conversation.
    const pane = await page.getByRole('region', { name: 'Open chat' }).boundingBox();
    const box = await title.boundingBox();
    expect(pane).not.toBeNull();
    const paneCentre = pane!.x + pane!.width / 2;
    const titleCentre = box!.x + box!.width / 2;
    expect(Math.abs(paneCentre - titleCentre)).toBeLessThan(4);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'not found',
      source: SOURCE,
    });

    await expect(back).toHaveAttribute('href', /\/chats$/);
    await back.click();
    // Beside the list the latest chat opens on arrival (COR-2445): the first row's chat, in place.
    const first = page.locator('[data-chat]').first();
    await expect(first).toBeVisible();
    const firstId = await first.getAttribute('data-chat');
    expect(firstId).not.toBeNull();
    await expect(page).toHaveURL(
      (url) => url.pathname === `/chats/${encodeURIComponent(firstId ?? '')}`,
    );
  });
});

test.describe('A turn that ends on a tool call (frame j: 20h)', () => {
  test('is Done with a green dot, shows the message and the Lookup order row, no agent reply, and says it wrote no answer once after its steps (20h, now R6)', async ({
    page,
    request,
  }) => {
    await connectProvider(page);
    await openStatesChat(page, request, 'ended-on-tool-call');
    await expect(railRow(page, 'Lookup order')).toBeVisible();

    await expectTopBar(page);
    expect(await statusOf(page)).toEqual({ word: 'Done', dot: 'success' });
    const user = transcript(page).locator('[data-role="user"], .chat-message--user').first();
    await expect(user).toContainText(REFUND_TITLE);
    await expect(user).toContainText('10:41 AM');
    await expect(user.getByRole('button', { name: /Branch/ })).toBeVisible();
    await expect(user.getByRole('button', { name: /Copy/ })).toBeVisible();
    const lookup = railRow(page, 'Lookup order');
    await expect(lookup).toContainText('4471');
    await expect(lookup).toContainText('→ $42.00, delivered Monday, flagged damaged');
    await expect(lookup).toContainText('0.4s');
    // No agent reply. R6 supersedes row 20h's rail footnote (COR-2725): the turn says it wrote no
    // answer once, in a row after its steps, with its time and Try again.
    await expect(transcript(page).locator('[data-role="assistant"]')).toHaveCount(0);
    const empty = transcript(page).locator('.chat-turn-outcome[data-kind="empty"]');
    await expect(empty).toContainText('The agent finished without writing an answer.');
    await expect(empty.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(rail(page)).not.toContainText('Run finished, no reply');
    await expect(transcript(page).locator('.chat-note')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'turn ends on a tool call',
      source: SOURCE,
    });
  });

  test('the empty answer row reads at 768, 375 and 320 (R6)', async ({ page, request }) => {
    await connectProvider(page);
    await openStatesChat(page, request, 'ended-on-tool-call');
    await page.setViewportSize({ width: 768, height: 900 });
    const empty = transcript(page).locator('.chat-turn-outcome[data-kind="empty"]');
    await expect(empty.getByRole('button', { name: 'Try again' })).toBeVisible();
    // 768 as asked, then 375 and 320 as the phone helper repeats it.
    await captureForDesignReviewWithPhone(page, {
      route: '/chats/:chat',
      state: 'turn ends on a tool call',
      source: SOURCE,
    });
  });
});

// COR-2725: R3 to R6 supersede rows 20b and 20h, so a turn the run only called tools in says how it
// ended once, on Chat's anchor after its steps. Each state is captured by name at 1280 and at a phone.
const FOLLOW_UP_ROW = {
  id: 'user-states-follow-up',
  role: 'user',
  content: 'And check order 4472 too.',
  metadata: { _followUp: true },
};

/** What the Bureau answers for the tool-only chat, which a test turns on one state at a time. */
interface ToolOnlyTurn {
  /** How the chat's last run ended; the sample's own record says it finished. */
  readonly run?: 'canceled' | 'failed';
  /** A message the person typed after the steps, which joined the turn. */
  readonly followUp?: boolean;
  /** How the Bureau answers a Discard or a Continue. */
  readonly command?: 'removes' | 'refuses' | 'holds';
  /** The run's stream reads the rows and then ends, so the page reconnects. */
  readonly dropped?: boolean;
}

/** Opens the tool-only chat as `turn` says, and returns what the page asked the Bureau to do. */
async function openToolOnlyTurn(
  page: Page,
  request: Parameters<typeof openStatesChat>[1],
  turn: ToolOnlyTurn,
): Promise<{ readonly commands: string[]; readonly release: () => void }> {
  await connectProvider(page);
  await openStatesChat(page, request, 'ended-on-tool-call');
  const commands: string[] = [];
  let rows = [...messagesOf('ended-on-tool-call'), ...(turn.followUp ? [FOLLOW_UP_ROW] : [])];
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      id?: unknown;
      params?: { contextId?: string; runId?: string };
    };
    const tasks = tasksOf('ended-on-tool-call').map((task) => ({
      ...task,
      status: turn.run ?? task['status'],
      finishReason:
        turn.run === undefined
          ? task['finishReason']
          : turn.run === 'canceled'
            ? 'aborted'
            : 'error',
      statusMessage:
        turn.run === 'failed'
          ? 'The model provider dropped the connection.'
          : task['statusMessage'],
    }));
    // The chat list and the bell read every chat's recent runs: they say what the header says.
    if (
      body.method === 'bureau.tasks.list' &&
      body.params?.contextId === undefined &&
      turn.run !== undefined
    ) {
      const response = await route.fetch();
      const listed = (await response.json()) as { result?: { tasks?: Record<string, unknown>[] } };
      await route.fulfill({
        response,
        json: {
          ...listed,
          result: {
            ...listed.result,
            tasks: [
              ...tasks,
              ...(listed.result?.tasks ?? []).filter(
                (task) => task['contextId'] !== ENDED_ON_TOOL_CALL_THREAD,
              ),
            ],
          },
        },
      });
      return;
    }
    if (body.params?.contextId !== ENDED_ON_TOOL_CALL_THREAD) {
      await route.fallback();
      return;
    }
    if (body.method === 'bureau.tasks.list' && turn.run !== undefined) {
      await route.fulfill({
        json: { jsonrpc: '2.0', id: body.id, result: { tasks, nextPageToken: null } },
      });
      return;
    }
    if (
      (body.method === 'bureau.contexts.discardturn' ||
        body.method === 'bureau.contexts.resumeturn') &&
      turn.command !== undefined
    ) {
      commands.push(body.method);
      if (turn.command === 'holds') await held;
      if (turn.command === 'refuses' || turn.command === 'holds') {
        await route.fulfill({
          json: {
            jsonrpc: '2.0',
            id: body.id,
            error: {
              code: -32000,
              message: 'refused',
              data: { reason: 'history-changed', weftCode: 'Conflict', httpStatus: 409 },
            },
          },
        });
        return;
      }
      // The Bureau removed the run's rows: the thread read again holds the person's message alone.
      rows = rows.slice(0, 1);
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id: body.id,
          result: { contextId: ENDED_ON_TOOL_CALL_THREAD, runId: body.params?.runId, removed: 2 },
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.route(`**/ag-ui/threads/${ENDED_ON_TOOL_CALL_THREAD}/messages`, (route) =>
    route.fulfill({ json: { threadId: ENDED_ON_TOOL_CALL_THREAD, messages: rows } }),
  );
  if (turn.dropped) {
    let read = 0;
    await page.route(`**/ag-ui/threads/${ENDED_ON_TOOL_CALL_THREAD}/run`, (route) => {
      read += 1;
      // The first read joins the run and then the stream ends with no terminal event; the retries
      // find the server gone, so the turn stays on its reconnect while the page is captured.
      if (read > 1) return route.abort('connectionreset');
      return route.fulfill({
        contentType: 'text/event-stream',
        body: [
          { type: 'RUN_STARTED', threadId: ENDED_ON_TOOL_CALL_THREAD, runId: 'run-states-dropped' },
          { type: 'MESSAGES_SNAPSHOT', messages: rows },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
      });
    });
  }
  await page.reload();
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  return { commands, release };
}

const toolOnlyOutcome = (page: Page, kind: string): Locator =>
  transcript(page).locator(`.chat-turn-outcome[data-kind="${kind}"]`);

test.describe('A chat turn of only tool calls and how it ended (COR-2725)', () => {
  test('stopped by the person: one pill after the steps with Continue and Discard, and no status line', async ({
    page,
    request,
  }) => {
    await openToolOnlyTurn(page, request, { run: 'canceled' });
    const stopped = toolOnlyOutcome(page, 'stopped');
    await expect(stopped.getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(stopped.getByRole('button', { name: 'Discard' })).toBeVisible();
    await expect(page.locator('.chat-turn-outcome')).toHaveCount(1);
    await expect(transcript(page).locator('.chat-note')).toHaveCount(0);
    await expect(rail(page)).not.toContainText('Run finished, no reply');
    await captureForDesignReviewWithPhone(page, {
      route: '/chats/:chat',
      state: 'tool-only turn stopped',
      source: SOURCE,
    });
  });

  test('failed: one danger alert after the steps with its cause, Retry and Why it failed', async ({
    page,
    request,
  }) => {
    await openToolOnlyTurn(page, request, { run: 'failed' });
    const failed = toolOnlyOutcome(page, 'failed');
    await expect(failed).toContainText('Failed before an answer.');
    await expect(failed.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.locator('.chat-turn-outcome')).toHaveCount(1);
    await expect(transcript(page).locator('.chat-note')).toHaveCount(0);
    await captureForDesignReviewWithPhone(page, {
      route: '/chats/:chat',
      state: 'tool-only turn failed',
      source: SOURCE,
    });
  });

  test('reconnecting: the connection notice by the composer says so once, with Retry now', async ({
    page,
    request,
    pageErrors,
  }) => {
    // The test drops the run's stream on purpose, and the page's retries of it are reset: the reports
    // are the cause the test made, for this chat's run URL alone.
    const runUrl = `/ag-ui/threads/${ENDED_ON_TOOL_CALL_THREAD}/run`;
    pageErrors.expectEvery({
      pattern: new RegExp(`^request failed: GET .*${runUrl} \\(net::ERR_CONNECTION_RESET\\)$`),
      reason: 'the test drops the run stream, so the page’s retries of it are reset',
    });
    pageErrors.expectEvery({
      pattern: new RegExp(
        `^console error: Failed to load resource: net::ERR_CONNECTION_RESET \\(.*${runUrl}`,
      ),
      reason: 'the test drops the run stream, so Chromium logs each reset retry',
    });
    await openToolOnlyTurn(page, request, { dropped: true });
    const notice = page.locator('.chat-connection-notice');
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText('Connection lost. Reconnecting');
    await expect(notice.getByRole('button', { name: 'Retry now' })).toBeVisible();
    await expect(page.locator('.chat-turn-outcome')).toHaveCount(0);
    await captureForDesignReviewWithPhone(page, {
      route: '/chats/:chat',
      state: 'tool-only turn reconnecting',
      source: SOURCE,
    });
  });

  test('a message typed after the steps joins the turn, and the outcome stands before it', async ({
    page,
    request,
  }) => {
    await openToolOnlyTurn(page, request, { run: 'canceled', followUp: true });
    const stopped = toolOnlyOutcome(page, 'stopped');
    await expect(stopped).toBeVisible();
    const typed = transcript(page).locator(`[data-message-id="${FOLLOW_UP_ROW.id}"]`);
    await expect(typed).toBeVisible();
    const { outcome, after } = await readBoxes(page, { outcome: stopped, after: typed });
    expect(outcome.y).toBeLessThan(after.y);
    await captureForDesignReviewWithPhone(page, {
      route: '/chats/:chat',
      state: 'outcome before a trailing follow-up',
      source: SOURCE,
    });
  });

  test('Discard removes the turn: the person’s message alone, with the plain line that says why', async ({
    page,
    request,
  }) => {
    const { commands } = await openToolOnlyTurn(page, request, {
      run: 'canceled',
      command: 'removes',
    });
    await toolOnlyOutcome(page, 'stopped').getByRole('button', { name: 'Discard' }).click();
    await expect(page.locator('.chat-turn-outcome')).toHaveCount(0);
    await expect(transcript(page).getByText('The run was stopped.')).toBeVisible();
    expect(commands).toEqual(['bureau.contexts.discardturn']);
    await captureForDesignReviewWithPhone(page, {
      route: '/chats/:chat',
      state: 'stopped tool-only turn after Discard',
      source: SOURCE,
    });
  });

  test('a Discard the Bureau refuses is said once, on the turn, and the controls come back', async ({
    page,
    request,
  }) => {
    await openToolOnlyTurn(page, request, { run: 'canceled', command: 'refuses' });
    const stopped = toolOnlyOutcome(page, 'stopped');
    await stopped.getByRole('button', { name: 'Discard' }).click();
    const said = transcript(page).locator('.chat-turn-command-failure');
    await expect(said).toHaveCount(1);
    // A turn of only tool calls wrote no reply, so the line names none.
    await expect(said).toContainText('The stopped turn wasn’t discarded. Try again.');
    await expect(stopped.getByRole('button', { name: 'Discard' })).toBeEnabled();
    await expect(stopped.getByRole('button', { name: 'Continue' })).toBeEnabled();
    await captureForDesignReviewWithPhone(page, {
      route: '/chats/:chat',
      state: 'refused command said once on the turn',
      source: SOURCE,
    });
  });

  test('a command under way: its control is busy and the turn’s other control is held', async ({
    page,
    request,
  }) => {
    const { release } = await openToolOnlyTurn(page, request, {
      run: 'canceled',
      command: 'holds',
    });
    const stopped = toolOnlyOutcome(page, 'stopped');
    await stopped.getByRole('button', { name: 'Continue' }).click();
    await expect(stopped.getByRole('button', { name: 'Continue' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(stopped.getByRole('button', { name: 'Discard' })).toBeDisabled();
    // At every width the busy control rests fully above the composer, so the capture shows it.
    const busyAboveComposer = async (shown: Page): Promise<void> => {
      const busy = toolOnlyOutcome(shown, 'stopped').getByRole('button', { name: 'Continue' });
      await busy.scrollIntoViewIfNeeded();
      await expect(busy).toHaveAttribute('aria-busy', 'true');
      await expect(busy).toBeInViewport({ ratio: 1 });
      const { control, composer } = await readBoxes(shown, {
        control: busy,
        composer: shown.locator('.chat-input-area'),
      });
      expect(control.y + control.height).toBeLessThanOrEqual(composer.y + 1);
    };
    await busyAboveComposer(page);
    await captureForDesignReviewWithPhone(page, {
      route: '/chats/:chat',
      state: 'command under way with the turn held',
      source: SOURCE,
      ready: busyAboveComposer,
    });
    release();
  });
});
