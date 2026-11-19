/**
 * The owner's approval at every width (COR-2438): Smoke tester asks to run `bureau__discover-agents`,
 * a read-only tool set to Always, with no arguments (`fixtures/chat-states.ts`, `discover-agents`).
 * At 1280, 768 and 375 pixels, in both themes, the card keeps the messages' measure, the tool-call
 * row and the card share one leading edge, Waiting on you is a warning Badge right after the tool's
 * name, there is no Input and no middle dot, the question is never the policy's reason, an Always
 * tool offers no grant for the rest of the chat, and the raw identifier is not shown. Pressing
 * Approve when nothing waits on the approval says so in one sentence, takes Approve and Deny away
 * and moves nothing on the page. The chat list is flush to the rail and the top bar.
 */
import type { Page } from '@playwright/test';

import {
  DISCOVER_AGENTS_ASK,
  DISCOVER_AGENTS_REASON,
  DISCOVER_AGENTS_THREAD,
} from '../../fixtures/chat-states.ts';
import { CHAT_COPY } from '../../src/app/copy/chat.ts';
import { openStatesChat } from './chat-states-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';

const SOURCE = 'tests/e2e/chat-approval-wide.spec.ts';

/** The measure of a message in the transcript: Chat's `--cinder-chat-message-max-width`, 48rem. */
const MESSAGE_MEASURE = 768;

const MIDDLE_DOT = String.fromCodePoint(0xb7);

const card = (page: Page) => page.locator('.cinder-approval-card[data-approval-decision]');
const toolRow = (page: Page) =>
  page.locator('[data-cinder-tool-call-row]').filter({ hasText: /Discover agents/i });

/** 10: the row's Waiting badge became a neutral "No longer waiting" Badge right after the name. */
async function expectNoLongerWaitingBadge(page: Page): Promise<void> {
  const badges = toolRow(page).locator('.cinder-tool-call-rail__name > .cinder-badge');
  await expect(badges).toHaveCount(1);
  await expect(badges).toHaveText(CHAT_COPY.tools.noLongerWaiting);
  await expect(badges).toHaveAttribute('data-cinder-variant', 'neutral');
  await expect(toolRow(page).locator('.cinder-tool-call-rail__result')).toHaveCount(0);
}

async function openAt(
  page: Page,
  request: Parameters<typeof openStatesChat>[1],
  width: number,
  theme: 'light' | 'dark',
): Promise<void> {
  await page.addInitScript((selected) => {
    localStorage.setItem('weft-ui-theme', selected);
  }, theme);
  await openStatesChat(page, request, 'discover-agents');
  await page.setViewportSize({ width, height: 900 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(card(page)).toBeVisible();
}

test.describe('the approval on a chat (/chats/:chat)', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1280, 768, 375]) {
      test(`draws the Always approval with no arguments as agreed, at ${width} pixels (${theme})`, async ({
        page,
        request,
      }) => {
        await openAt(page, request, width, theme);
        const approval = card(page);
        const row = toolRow(page);
        await expect(row).toBeVisible();

        const name = row.locator('.cinder-tool-call-rail__name-text');
        const badge = row.locator('.cinder-tool-call-rail__name > .cinder-badge');
        await expect(badge).toHaveText('Waiting on you');
        await expect(badge).toHaveAttribute('data-cinder-variant', 'warning');
        const {
          card: cardBox,
          surface,
          row: rowBox,
          name: nameBox,
          badge: badgeBox,
        } = await readBoxes(page, {
          card: approval,
          surface: page.locator('.weft-chat-surface'),
          row,
          name,
          badge,
        });

        // 1. The card keeps the messages' measure, never the whole pane.
        expect(cardBox.width).toBeLessThanOrEqual(MESSAGE_MEASURE + 0.5);
        expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(surface.x + surface.width + 0.5);

        // 2. The row and the card start at one inline edge.
        expect(Math.abs(rowBox.x - cardBox.x)).toBeLessThanOrEqual(1);

        // 3. Waiting on you is a warning Badge right after the tool's name.
        expect(badgeBox.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width - 1);
        expect(badgeBox.x - (nameBox.x + nameBox.width)).toBeLessThanOrEqual(12);
        expect(
          Math.abs(badgeBox.y + badgeBox.height / 2 - (nameBox.y + nameBox.height / 2)),
        ).toBeLessThanOrEqual(2);

        // 4. No arguments, so no Input.
        await expect(approval.getByRole('group', { name: 'Input' })).toHaveCount(0);
        await expect(approval).not.toContainText('Empty');

        // 5. No middle dot anywhere in the card.
        expect(await approval.textContent()).not.toContain(MIDDLE_DOT);

        // 6. The question, never the policy's reason.
        const question = approval.getByRole('heading', { level: 4 });
        await expect(question).not.toContainText('requires approval');
        await expect(question).toHaveText(/^Run .*Discover agents\?$/i);
        await expect(approval).not.toContainText(DISCOVER_AGENTS_REASON);

        // 7. An Always tool offers no grant for the rest of the chat.
        await expect(approval.getByRole('checkbox')).toHaveCount(0);

        // 8. The display name only, never the raw identifier.
        await expect(approval).not.toContainText('bureau__discover-agents');
        await expect(approval.locator('code')).toHaveCount(0);
        await captureForDesignReview(page, {
          route: '/chats/:chat',
          state: `Always approval with no arguments (${theme})`,
          source: SOURCE,
        });
      });
    }
  }

  test('a decision on an approval nothing waits on says so once, ends the pending card and moves nothing', async ({
    page,
    request,
  }) => {
    await openAt(page, request, 1280, 'dark');
    const lastMessage = page.locator('[data-message-role="user"]').last();
    const composer = page.locator('.chat-input-area').first();
    await expect(lastMessage).toContainText(DISCOVER_AGENTS_ASK);
    const before = await readBoxes(page, { message: lastMessage, composer });

    // The run that asked is gone (the thread has nothing to attach to), so nothing waits on it.
    await card(page).getByRole('button', { name: 'Approve' }).click();

    // 11. One error that says one thing, not "The agent did not answer" over the refusal.
    const alerts = page.getByTestId('chat-alerts');
    await expect(alerts).toContainText(CHAT_COPY.approval.notWaiting);
    await expect(alerts).not.toContainText(CHAT_COPY.failureTitle);
    await expect(alerts).not.toContainText('No approval is waiting for this tool call.');
    await expect(alerts.locator('.cinder-alert')).toHaveCount(1);

    // 10. The card leaves the pending state and says what happened; the row's badge goes with it.
    await expect(card(page)).toContainText(CHAT_COPY.approval.lapsed);
    await expect(card(page).getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: 'Deny' })).toHaveCount(0);
    await expectNoLongerWaitingBadge(page);

    // 14. The list's row (which the segment counts read) and the header say what the card says.
    const header = page.locator('[data-testid="chat-header"] .cinder-page-header__status');
    await expect(header.locator('.cinder-badge')).toHaveText(CHAT_COPY.status.done);
    const listed = page.locator('[data-chat]').filter({ hasText: DISCOVER_AGENTS_ASK });
    await expect(listed).toHaveCount(1);
    await expect(listed).not.toContainText(CHAT_COPY.status.waiting);
    await expect(listed).toContainText(CHAT_COPY.status.done);

    // 12. The error moved nothing: the last message and the composer are where they were.
    const after = await readBoxes(page, { message: lastMessage, composer });
    for (const key of ['message', 'composer'] as const) {
      expect(Math.abs(after[key].x - before[key].x), key).toBeLessThanOrEqual(0.5);
      expect(Math.abs(after[key].y - before[key].y), key).toBeLessThanOrEqual(0.5);
      expect(Math.abs(after[key].height - before[key].height), key).toBeLessThanOrEqual(0.5);
    }
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'a decision on an approval no longer waiting',
      source: SOURCE,
    });
  });
});

test('a page that loads the chat after its approval stopped waiting never shows it pending', async ({
  page,
  request,
}) => {
  // The Bureau no longer says the chat waits on its person, and its thread has no run to attach to.
  await openStatesChat(page, request, 'discover-agents', undefined, { activity: 'idle' });
  await expect(page).toHaveURL(new RegExp(DISCOVER_AGENTS_THREAD));
  await expect(card(page)).toContainText(CHAT_COPY.approval.lapsed);
  await expect(card(page).getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(card(page).getByRole('button', { name: 'Deny' })).toHaveCount(0);
  await expectNoLongerWaitingBadge(page);
});

// 13. The chat list is flush to the navigation rail and the top bar, with no frame of its own.
for (const width of [1280, 1440, 1920]) {
  test(`puts the chat list flush to the rail and the top bar, at ${width} pixels`, async ({
    page,
    request,
  }) => {
    await openAt(page, request, width, 'dark');
    const edges = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
      const list = document.querySelector<HTMLElement>('.cinder-list-detail__list');
      const style = list === null ? undefined : getComputedStyle(list);
      const root = document.querySelector<HTMLElement>('.cinder-list-detail');
      const rootStyle = root === null ? undefined : getComputedStyle(root);
      return {
        list: box('.cinder-list-detail__list'),
        main: box('.weft-shell-main'),
        topbar: box('header.weft-shell-topbar'),
        borderStart: style?.borderInlineStartWidth,
        borderTop: style?.borderTopWidth,
        radius: style?.borderTopLeftRadius,
        rootBorder: rootStyle?.borderTopWidth,
        rootRadius: rootStyle?.borderTopLeftRadius,
      };
    });
    expect(edges.list).toBeDefined();
    expect(Math.abs(edges.list!.left - edges.main!.left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(edges.list!.top - edges.topbar!.bottom)).toBeLessThanOrEqual(0.5);
    expect(edges.borderStart).toBe('0px');
    expect(edges.borderTop).toBe('0px');
    expect(edges.radius).toBe('0px');
    expect(edges.rootBorder).toBe('0px');
    expect(edges.rootRadius).toBe('0px');
  });
}
