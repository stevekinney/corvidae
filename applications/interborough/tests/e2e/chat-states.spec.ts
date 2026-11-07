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
  ENDED_PARTIAL_REPLY,
  FAILED_PARTWAY_REPLY,
  HELD_BY_PLUGIN_REASON,
  HELD_BY_PLUGIN_TITLE,
  REFUND_TITLE,
} from '../../fixtures/chat-states.ts';
import { SAMPLE_NOW_MILLISECONDS, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { SAMPLE_WORLD_THREADS } from '../../fixtures/sample-world-records.ts';
import { connectProvider, open, openStatesChat } from './chat-states-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

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

/** The status word beside a chat's title, and the dot that comes with it. */
async function statusOf(page: Page): Promise<{ word: string; dot: string | null }> {
  const heading = header(page);
  const dot = heading.locator('.cinder-status-dot').first();
  const shown = await heading.innerText();
  const text = shown.replace(/\s+/g, ' ');
  return {
    word:
      ['Waiting on you', 'Running', 'Failed', 'Ended', 'Done'].find((word) =>
        text.includes(word),
      ) ?? '',
    dot: (await dot.count()) === 0 ? null : await dot.getAttribute('data-cinder-status'),
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
    await expect(page.locator('[data-approval-decision]')).toBeVisible();
    const status = await statusOf(page);
    expect(status.word).toBe('Waiting on you');
  });
});

test.describe('No model provider connected (frame b: 19f, 19h)', () => {
  test('shows the refund chat waiting on you, with its message, its Lookup order row and its reply (19f)', async ({
    page,
  }) => {
    await open(page, `/chats/${SAMPLE_WORLD_THREADS.refund}`);
    await expect(page.locator('[data-approval-decision]')).toBeVisible();

    await expectTopBar(page);
    await expect(
      trail(page).getByRole('button', { name: /^Please refund order 4471/ }),
    ).toBeVisible();
    expect(await statusOf(page)).toEqual({ word: 'Waiting on you', dot: 'warning' });

    const conversation = transcript(page);
    const message = conversation.getByText(REFUND_TITLE).last();
    await expect(message).toBeVisible();
    const user = conversation.locator('[data-role="user"], .chat-message--user').last();
    await expect(user.getByRole('button', { name: /Copy/ })).toBeVisible();
    const lookup = railRow(page, 'Lookup order').last();
    await expect(lookup).toContainText('4471');
    // The reply is stamped with when it was written and the model that wrote it.
    await expect(conversation.getByText(/10:42 AM\s*·\s*Claude Sonnet 5\.5/)).toBeVisible();
    // The composer is the one blocked row, not a banner.
    await expect(blockedRow(page)).toContainText('Connect a model provider to chat');
    await expect(blockedRow(page).getByRole('link', { name: 'Connect a provider' })).toBeVisible();
    await expect(page.locator('.cinder-banner')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'no model provider',
      source: SOURCE,
    });
  });

  test('keeps Approve and Deny enabled, queues nothing, and says Tool runner continues once a provider is connected (19h)', async ({
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
    const note = page.locator('.weft-chat-approval__provider-note');
    await expect(note).toHaveText('Tool runner continues once a provider is connected.');
    // The note is muted text under the approval, outside its card.
    const [card, line] = await Promise.all([approval.boundingBox(), note.boundingBox()]);
    expect(line!.y).toBeGreaterThanOrEqual(card!.y + card!.height - 1);
    // Nothing pretends to be pending: no queued message, no "Sending" line.
    await expect(page.getByText(/^Queued/)).toHaveCount(0);
    await expect(page.getByText(/Sending…|Sending resumes/)).toHaveCount(0);
  });
});

test.describe('Agent’s plugin is disabled (frame c: 19k)', () => {
  test('shows a Release helper chat waiting on you, its message and its List changes row, and draws no banner (19k)', async ({
    page,
    request,
  }) => {
    await openStatesChat(page, request, 'held-by-plugin', HELD_NOW);
    await expect(page.getByText(HELD_BY_PLUGIN_REASON)).toBeVisible();

    await expectTopBar(page);
    await expect(trail(page).getByRole('button', { name: HELD_BY_PLUGIN_TITLE })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: HELD_BY_PLUGIN_TITLE })).toBeVisible();
    expect(await statusOf(page)).toEqual({ word: 'Waiting on you', dot: 'warning' });

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
    // The host is asked to restart and answers no more, so the chat reads what it knew.
    let down = false;
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
    await expect(page.getByText('Sending resumes when Interborough is back.')).toBeVisible();

    const conversation = transcript(page);
    const row = railRow(page, 'List changes');
    await expect(row).toContainText('0.8s');
    const card = conversation.locator('.cinder-approval-card');
    await expect(card).toContainText('Publish notes for 2.4?');
    await expect(card.locator('.cinder-approval-card__state-word')).toHaveText('Unavailable');
    await expect(card).toContainText('Changes things');
    await expect(card).toContainText('Approval from Release helper');
    await expect(card).toContainText('12 min ago');
    await expect(card).toContainText('Version 2.4');
    await expect(card).toContainText('Changes 12');
    await expect(card).toContainText(HELD_BY_PLUGIN_REASON);
    await expect(card.getByRole('button')).toHaveCount(0);
    // Full contrast: neither the row nor the held approval is dimmed.
    expect(await opacityOf(row)).toBe(1);
    expect(await opacityOf(card)).toBe(1);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'restarting after enable and restart',
      source: SOURCE,
    });
  });
});

test.describe('Reply failed partway (frame f: 19p)', () => {
  test('is Failed with a red dot, keeps the message, the Lookup order row and the partial text, and says why with Retry (19p)', async ({
    page,
    request,
  }) => {
    await connectProvider(page);
    await openStatesChat(page, request, 'failed-partway');
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
    const line = transcript(page).locator('.chat-note[data-failed]');
    await expect(line).toContainText(
      'The reply stopped partway: the model provider dropped the connection.',
    );
    await expect(line.getByRole('button', { name: 'Retry' })).toBeVisible();
    // The conversation stays live: a provider is connected, so the composer takes a message.
    await expect(page.getByRole('textbox', { name: /^Message/ })).toBeVisible();
    await expect(blockedRow(page)).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'reply failed partway',
      source: SOURCE,
    });
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
    await expect(create).toHaveAttribute('data-cinder-variant', 'primary');
    const back = page.getByRole('link', { name: 'Back to chats' });
    await expect(back).toHaveAttribute('data-cinder-variant', 'secondary');
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

    await back.click();
    await expect(page).toHaveURL(/\/chats$/);
  });
});

test.describe('A turn that ends on a tool call (frame j: 20h)', () => {
  test('is Done with a green dot, shows the message and the Lookup order row, no agent reply, and closes the rail with the run finished (20h)', async ({
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
    // No agent reply, and the rail says the run is over rather than looking hung.
    await expect(transcript(page).locator('[data-role="assistant"]')).toHaveCount(0);
    await expect(rail(page)).toContainText('Run finished · no reply');
    await expect(transcript(page).locator('.chat-note')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'turn ends on a tool call',
      source: SOURCE,
    });
  });
});
