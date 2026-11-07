/**
 * New chat (`/chats/new`) on the sample world (`fixtures/sample-world-seed.ts`, the showcase host)
 * at the browser's sample clock, Monday, Nov 2, 10:46 AM Central time (COR-2016, design rows 23a to
 * 23r of PageNewChat): the default frame, where no provider is connected and the page starts with
 * Assistant, a scripted agent; the same page with Tool runner, a model agent, and so the blocked
 * row; and the swap back to Assistant that unblocks the composer. Each frame is captured for the
 * design review under its own name.
 */
import type { Locator, Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'chat-new.spec.ts';
const ASSISTANT_SENTENCE = 'Answers every message with the same scripted reply.';
const TOOL_RUNNER_SENTENCE = 'Looks an order up, then asks for approval to refund it.';
const REASON = 'Connect a model provider to chat';

/** Opens `path` at `width` by 900 pixels on the sample clock, once New chat holds its greeting. */
async function open(page: Page, path: string, width = 1440): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(page.getByTestId('new-chat-welcome')).toBeVisible();
  await expect(page.getByTestId('new-chat-choices')).toBeVisible();
}

const welcome = (page: Page) => page.getByTestId('new-chat-welcome');
const prompts = (page: Page) => page.getByRole('group', { name: 'Example prompts' });
const others = (page: Page) => page.getByRole('group', { name: 'Or chat with' });
const blockedRow = (page: Page) => page.locator('[data-chat-composer-status="blocked"]');
const composerBox = (page: Page) => page.getByRole('textbox', { name: 'Message' });
const chatList = (page: Page) => page.getByRole('region', { name: 'Chats' });

/** The box of `locator`, which must be on the page. */
async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, 'the element is on the page').not.toBeNull();
  return box!;
}

/** The text of each button in `group`, with its avatar's initials first. */
async function agentsIn(group: Locator): Promise<string[]> {
  const texts = await group.getByRole('button').allInnerTexts();
  return texts.map((text) => text.replaceAll(/\s+/g, ' ').trim());
}

/** Whether the page scrolls sideways. */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test.describe('New chat on the sample world (23a, 23b, 23c, 23e, 23g, 23j)', () => {
  test('is the route /chats/new under the breadcrumb "Chat › New chat", with the greeting as its only title (23a, 23b)', async ({
    page,
  }) => {
    await open(page, '/chats/new');
    expect(new URL(page.url()).pathname).toBe('/chats/new');
    const trail = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(trail).toContainText('Chat');
    await expect(trail.locator('[aria-current="page"]')).toHaveText('New chat');
    // Chat is the active sidebar item, Reviews says 2, and Health carries its amber dot.
    const sidebar = page.getByRole('navigation', { name: 'Views' });
    await expect(sidebar.getByRole('link', { name: 'Chat', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(sidebar.getByRole('link', { name: 'Reviews, 2 need you' })).toContainText('2');
    await expect(
      sidebar.getByRole('link', { name: /Health/ }).locator('.cinder-status-dot'),
    ).toHaveAttribute('data-cinder-status', 'warning');
    // The greeting is the title: no page header, no heading above it and no subtitle.
    await expect(page.getByTestId('chat-header')).toHaveCount(0);
    await expect(welcome(page).getByRole('heading', { level: 1 })).toHaveText(
      'What should Assistant do?',
    );
    await expect(page.getByRole('heading', { name: 'New chat' })).toHaveCount(0);
    await expect(page.getByText('Pick an agent and ask it something.')).toHaveCount(0);
  });

  test('defaults to Assistant with a live Send, and offers no Model or Effort (23c)', async ({
    page,
  }) => {
    await open(page, '/chats/new');
    const pill = page.getByRole('combobox', { name: 'Agent' });
    await expect(pill).toContainText('Assistant');
    await expect(composerBox(page)).toBeEnabled();
    await expect(composerBox(page)).toHaveAttribute('placeholder', 'Message Assistant…');
    // A scripted agent has nothing to pick: only Permissions is offered, and nothing is blocked.
    await expect(page.getByRole('combobox', { name: 'Model' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Effort' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: /Permissions/ })).toBeVisible();
    await expect(blockedRow(page)).toHaveCount(0);
    await expect(page.getByText(REASON)).toHaveCount(0);
    // Send is secondary and disabled until there is text, then live.
    const send = page.getByRole('button', { name: 'Send message' });
    await expect(send).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(send).toBeDisabled();
    await composerBox(page).fill('Say hello');
    await expect(send).toBeEnabled();
  });

  test('centres a 48 pixel avatar, the greeting and the agent’s sentence, with the composer under them (23g)', async ({
    page,
  }) => {
    await open(page, '/chats/new');
    const avatar = welcome(page).locator('.ib-new-chat__avatar');
    await expect(avatar).toHaveText('A');
    const avatarBox = await boxOf(avatar);
    expect([avatarBox.width, avatarBox.height]).toEqual([48, 48]);
    const greeting = welcome(page).getByRole('heading', { level: 1 });
    const sentence = welcome(page).getByText(ASSISTANT_SENTENCE);
    await expect(sentence).toBeVisible();
    const pane = await boxOf(page.getByRole('region', { name: 'Open chat' }));
    const centreOf = (box: { x: number; width: number }) => box.x + box.width / 2;
    for (const part of [avatar, greeting, sentence]) {
      expect(Math.abs(centreOf(await boxOf(part)) - centreOf(pane))).toBeLessThanOrEqual(2);
    }
    // Avatar, greeting and sentence in that order, with the composer under the sentence.
    const greetingBox = await boxOf(greeting);
    const sentenceBox = await boxOf(sentence);
    const composer = await boxOf(page.locator('form.chat-input'));
    expect(greetingBox.y).toBeGreaterThan(avatarBox.y + avatarBox.height - 1);
    expect(sentenceBox.y).toBeGreaterThan(greetingBox.y + greetingBox.height - 1);
    expect(composer.y).toBeGreaterThan(sentenceBox.y + sentenceBox.height);
    // The greeting and the composer are one block in the middle of the pane, not a composer docked
    // to the bottom: there is room under the block as well as over it.
    const room = {
      over: avatarBox.y - pane.y,
      under: pane.y + pane.height - (composer.y + composer.height),
    };
    expect(room.under).toBeGreaterThan(40);
    expect(Math.abs(room.over - room.under)).toBeLessThan(160);
    expect(await scrollsSideways(page)).toBe(false);
  });

  test('offers one "Say hello" pill under the composer, then the other agents with avatars, Assistant not repeated (23j)', async ({
    page,
  }) => {
    await open(page, '/chats/new');
    await expect(prompts(page).getByRole('button')).toHaveText(['Say hello']);
    await expect(prompts(page)).toContainText('Try');
    expect(await agentsIn(others(page))).toEqual([
      'TR Tool runner',
      'RH Request human input',
      'WA Workflow author',
      'E Echo',
      'MS Model switcher',
    ]);
    await expect(others(page)).toContainText('Or chat with');
    // Under the composer, the Try row above the agents.
    const composer = await boxOf(page.locator('form.chat-input'));
    const tryBox = await boxOf(prompts(page));
    const agentsBox = await boxOf(others(page));
    expect(tryBox.y).toBeGreaterThan(composer.y + composer.height - 1);
    expect(agentsBox.y).toBeGreaterThan(tryBox.y + tryBox.height - 1);
    // A pill fills the composer and sends nothing.
    await prompts(page).getByRole('button', { name: 'Say hello' }).click();
    await expect(composerBox(page)).toHaveValue('Say hello');
    await expect(page).toHaveURL(/\/chats\/new$/);
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'default',
      source: SOURCE,
    });
  });

  test('lists the chats under their days beside it (23e)', async ({ page }) => {
    await open(page, '/chats/new');
    const list = chatList(page);
    const bands = list.locator('.cinder-data-list-group__header');
    await expect(bands.nth(0)).toHaveText(/^Today\s*Central time$/);
    await expect(bands.nth(1)).toHaveText(/^Yesterday · Sunday, Nov 1\s*Central time$/);
    await expect(bands.last()).toHaveText(/^Thursday, Oct 29\s*Central time$/);
    const row = (title: string) => list.locator('[data-chat]').filter({ hasText: title });
    const refund = row('Please refund order 4471, it arrived damaged.');
    await expect(refund).toContainText('10:42 AM');
    await expect(refund).toContainText('Waiting on you');
    const release = row('Ship the release notes fix.');
    await expect(release).toContainText('9:46 AM');
    await expect(release).toContainText('Waiting on you');
    await expect(release).toContainText('Which environment should the release go to?');
    const hello = row('Say hello');
    await expect(hello).toContainText('4:12 PM');
    await expect(hello).toContainText('Done');
    await expect(hello).toContainText('Hello! How can I help?');
    const billing = row('Rename the billing tables');
    await expect(billing).toContainText('11:05 AM');
    await expect(billing).toContainText('Ended');
    await expect(billing).toContainText('The server restarted before I finished.');
    // The new chat is the pane, not a row of its own.
    await expect(list.locator('[aria-current="true"]')).toHaveCount(0);
  });
});

test.describe('New chat with no model provider (23k, 23l, 23n, 23o)', () => {
  test('greets Tool runner with its avatar and sentence over the blocked row, and no Try pills (23k, 23l, 23n)', async ({
    page,
  }) => {
    await open(page, '/chats/new?agent=tool-runner');
    await expect(welcome(page).getByRole('heading', { level: 1 })).toHaveText(
      'What should Tool runner do?',
    );
    await expect(welcome(page).locator('.ib-new-chat__avatar')).toHaveText('TR');
    await expect(welcome(page).getByText(TOOL_RUNNER_SENTENCE)).toBeVisible();
    // One compact blocked row in place of the text box: the reason, the way out, and Use Assistant.
    const row = blockedRow(page);
    await expect(row.getByText(REASON)).toBeVisible();
    await expect(row.getByRole('link', { name: 'Connect a provider' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Use Assistant' })).toBeVisible();
    await expect(composerBox(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send message' })).toHaveCount(0);
    // The Try pills are hidden, because they would fill a box that cannot send; the agents stay.
    await expect(prompts(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Please refund order 4471' })).toHaveCount(0);
    expect(await agentsIn(others(page))).toEqual([
      'A Assistant',
      'RH Request human input',
      'WA Workflow author',
      'E Echo',
      'MS Model switcher',
    ]);
    // The row sits under the sentence and the agents under the row.
    const sentence = await boxOf(welcome(page).getByText(TOOL_RUNNER_SENTENCE));
    const blocked = await boxOf(row);
    const agents = await boxOf(others(page));
    expect(blocked.y).toBeGreaterThan(sentence.y + sentence.height);
    expect(agents.y).toBeGreaterThan(blocked.y + blocked.height - 1);
    expect(await scrollsSideways(page)).toBe(false);
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'no provider, Tool runner',
      source: SOURCE,
    });
  });

  test('draws no provider banner on the page, and leaves the notice to Health and its sidebar dot (23o)', async ({
    page,
  }) => {
    await open(page, '/chats/new?agent=tool-runner');
    await expect(page.locator('.cinder-banner')).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: /provider/i })).toHaveCount(0);
    // The only words about a provider are the blocked row's own, where sending is blocked.
    await expect(page.locator('main').getByText(/provider/i)).toHaveCount(2);
    await expect(blockedRow(page).getByText(/provider/i)).toHaveCount(2);
    // Health carries the rest, with the amber dot in the sidebar.
    const health = page.getByRole('navigation', { name: 'Views' }).getByRole('link', {
      name: /Health/,
    });
    await expect(health.locator('.cinder-status-dot')).toHaveAttribute(
      'data-cinder-status',
      'warning',
    );
  });
});

test.describe('Choosing Assistant unblocks the composer (23p, 23q, 23r)', () => {
  /** Counts the requests that would start a run, so a swap can be shown to send nothing. */
  function watchRuns(page: Page): string[] {
    const sent: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /ag-ui|\/run/.test(request.url())) {
        sent.push(request.url());
      }
    });
    return sent;
  }

  /** Whether the page now shows Assistant's greeting, live composer and Try pill. */
  async function expectAssistant(page: Page): Promise<void> {
    await expect(welcome(page).getByRole('heading', { level: 1 })).toHaveText(
      'What should Assistant do?',
    );
    await expect(welcome(page).locator('.ib-new-chat__avatar')).toHaveText('A');
    await expect(welcome(page).getByText(ASSISTANT_SENTENCE)).toBeVisible();
    await expect(blockedRow(page)).toHaveCount(0);
    await expect(composerBox(page)).toBeEnabled();
    const send = page.getByRole('button', { name: 'Send message' });
    await expect(send).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(send).toBeDisabled();
    await composerBox(page).fill('Hello');
    await expect(send).toBeEnabled();
    await composerBox(page).fill('');
    await expect(prompts(page).getByRole('button')).toHaveText(['Say hello']);
    // Only Permissions: no Model, no Effort.
    await expect(page.getByRole('combobox', { name: 'Model' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Effort' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: /Permissions/ })).toBeVisible();
    expect(await agentsIn(others(page))).toEqual([
      'TR Tool runner',
      'RH Request human input',
      'WA Workflow author',
      'E Echo',
      'MS Model switcher',
    ]);
  }

  test('"Use Assistant" swaps the agent, replaces the blocked row with the live composer and sends nothing (23q, 23r)', async ({
    page,
  }) => {
    const sent = watchRuns(page);
    await open(page, '/chats/new?agent=tool-runner');
    await expect(blockedRow(page)).toBeVisible();

    await blockedRow(page).getByRole('button', { name: 'Use Assistant' }).click();

    await expectAssistant(page);
    await expect(page).toHaveURL(/\/chats\/new\?agent=assistant$/);
    expect(sent).toEqual([]);
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'Assistant chosen from the blocked row',
      source: SOURCE,
    });
  });

  test('choosing Assistant in "Or chat with" does the same (23q)', async ({ page }) => {
    const sent = watchRuns(page);
    await open(page, '/chats/new?agent=tool-runner');

    await others(page)
      .getByRole('button', { name: /Assistant/ })
      .click();

    await expectAssistant(page);
    expect(sent).toEqual([]);
  });
});
