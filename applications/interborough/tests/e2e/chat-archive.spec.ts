/**
 * Archiving a chat on the real host (COR-2285 V5): Archive in the chat's More menu, with no question
 * asked, replaces the composer with Chat's neutral Archived bar (the archive glyph, `Archived <date>`,
 * a secondary New chat and the primary Unarchive) and leaves the conversation readable; a reload
 * keeps it. The chat list leaves the archived chat out and ends with one Archived chats row, which
 * opens the archived chats in the same pane with Chats as the way back (owner decision, 2026-11-14);
 * the chat is there and opens from it. Unarchive brings the composer back with the focus in its box,
 * and once no chat is archived the row is gone. A chat that waits on an approval is not archived, and
 * says why. Each case runs at a phone's width, where the list is a screen of its own, and a desktop's.
 *
 * Each case starts chats of its own on the main host and deletes them afterwards, so the sample
 * world, which other specs count, is never archived. Only this file archives chats, and its cases
 * run one after another, so a case that unarchives its chat leaves none archived.
 */
import type { Page } from '@playwright/test';

import { CHAT_COPY } from '../../src/app/copy/chat.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, test } from './fixtures.ts';
import { bureauCall } from './task-support.ts';

const SOURCE = 'chat-archive.spec.ts';
const MORE = CHAT_COPY.more;
const LIST = CHAT_COPY.list;
const AGENT = 'demo:assistant';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 900 },
] as const;

/** The chats the cases started, deleted once the file is done. */
const started: string[] = [];

test.afterAll(async () => {
  await deleteChats(started);
});

const moreButton = (page: Page) => page.getByRole('button', { name: MORE.label });
const archivedBar = (page: Page) => page.locator('[data-chat-composer-status="archived"]');
const composer = (page: Page) => page.getByRole('textbox', { name: /message/i });
/** The Archived chats row at the end of the chat list. */
const archivedEntry = (page: Page) => page.locator('[data-chats-archived-entry] a[href]');
const chatRow = (page: Page, threadId: string) => page.locator(`[data-chat="${threadId}"]`);

/** Starts a chat with one finished turn and opens its page. */
async function openChat(
  page: Page,
  request: Parameters<typeof runToEnd>[0],
  label: string,
  agent = AGENT,
  message = 'Hello',
): Promise<string> {
  const threadId = newThreadId(label);
  started.push(threadId);
  await runToEnd(request, agent, threadId, message);
  await page.goto(`/chats/${threadId}`);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  return threadId;
}

async function archivedAtOf(
  request: Parameters<typeof runToEnd>[0],
  threadId: string,
): Promise<string | null> {
  const context = (await bureauCall(request, 'bureau.contexts.get', {
    contextId: threadId,
  })) as { archivedAt?: string | null };
  return context.archivedAt ?? null;
}

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.width} pixels`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('archives from the More menu, lists the chat under Archived chats, and Unarchive brings it back', async ({
      page,
      request,
      checkA11y,
    }) => {
      const threadId = await openChat(page, request, 'archive');

      await moreButton(page).click();
      await expect(page.getByRole('menuitem')).toHaveText([
        new RegExp(MORE.rename),
        new RegExp(MORE.branch),
        new RegExp(MORE.export),
        // Anchored: "Archive" is also the end of "Unarchive".
        new RegExp(`^\\s*${MORE.archive}\\s*$`),
        new RegExp(MORE.delete),
      ]);
      await page.getByRole('menuitem', { name: MORE.archive, exact: true }).click();

      // No question first: the chat stays open, and the composer is the Archived bar.
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const bar = archivedBar(page);
      await expect(bar).toBeVisible();
      await expect(bar).toContainText(/Archived \w{3} \d{1,2}/);
      await expect(composer(page)).toHaveCount(0);
      const newChat = bar.getByRole('link', { name: CHAT_COPY.composer.newChat, exact: true });
      await expect(newChat).toHaveAttribute('href', '/chats/new');
      await expect(newChat).toHaveAttribute('data-cinder-variant', 'secondary');
      const unarchive = bar.getByRole('button', {
        name: CHAT_COPY.composer.unarchive,
        exact: true,
      });
      await expect(unarchive).toHaveAttribute('data-cinder-variant', 'primary');
      // The conversation is still there to read.
      await expect(
        page.getByText('Hello', { exact: true }).filter({ visible: true }).first(),
      ).toBeVisible();
      expect(typeof (await archivedAtOf(request, threadId))).toBe('string');
      await checkA11y(`an archived chat at ${viewport.width}px`);
      await captureForDesignReview(page, {
        route: '/chats/:chat',
        state: 'archived',
        source: SOURCE,
      });

      // The archive is the Bureau's, so a reload shows the bar again, and the menu offers Unarchive.
      await page.reload();
      await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
      await expect(archivedBar(page)).toBeVisible();
      await moreButton(page).click();
      await expect(page.getByRole('menuitem', { name: MORE.unarchive, exact: true })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: MORE.archive, exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menuitem')).toHaveCount(0);

      // The list leaves the chat out and ends with the Archived chats row (on a phone, the list is
      // its own screen).
      await page.goto('/chats');
      await expect(archivedEntry(page)).toBeVisible();
      await expect(archivedEntry(page)).toHaveText(LIST.archivedTitle);
      await expect(chatRow(page, threadId)).toHaveCount(0);
      await checkA11y(`the chat list with archived chats at ${viewport.width}px`);
      await captureForDesignReview(page, {
        route: '/chats',
        state: 'archived chats row',
        source: SOURCE,
      });

      // The row opens the archived chats in the same pane, with Chats as the way back.
      await archivedEntry(page).click();
      await expect(page).toHaveURL(/\/chats\?view=archived$/);
      const back = page.getByRole('link', { name: LIST.backToChats, exact: true });
      await expect(back).toBeFocused();
      await expect(back).toHaveText(CHAT_COPY.sessionsTitle);
      await expect(chatRow(page, threadId)).toBeVisible();
      await expect(archivedEntry(page)).toHaveCount(0);
      await checkA11y(`the archived chats at ${viewport.width}px`);
      await captureForDesignReview(page, {
        route: '/chats',
        state: 'archived view',
        source: SOURCE,
      });

      // Its chat opens as any chat does, on its Archived bar.
      await chatRow(page, threadId).locator('a[href]').first().click();
      await expect(page).toHaveURL(new RegExp(`/chats/${threadId}\\?view=archived$`));
      await expect(archivedBar(page)).toBeVisible();

      await archivedBar(page)
        .getByRole('button', { name: CHAT_COPY.composer.unarchive, exact: true })
        .click();
      await expect(archivedBar(page)).toHaveCount(0);
      await expect(composer(page)).toBeFocused();
      expect(await archivedAtOf(request, threadId)).toBeNull();

      // With no chat archived, the list has no Archived chats row, and the chat is back in it.
      await page.goto('/chats');
      await expect(chatRow(page, threadId)).toBeVisible();
      await expect(archivedEntry(page)).toHaveCount(0);
    });

    test('refuses to archive a chat that waits on an approval, and says why', async ({
      page,
      request,
      checkA11y,
    }) => {
      // The tool runner asks before it refunds, so its chat waits on the person.
      await openChat(page, request, 'archive-busy', 'demo:tool-runner', 'Refund order-1001');

      await moreButton(page).click();
      await page.getByRole('menuitem', { name: MORE.archive, exact: true }).click();

      await expect(page.locator('.cinder-toast', { hasText: MORE.archiving.busy })).toBeVisible();
      await expect(archivedBar(page)).toHaveCount(0);
      await checkA11y(`an archive refused at ${viewport.width}px`);
      await captureForDesignReview(page, {
        route: '/chats/:chat',
        state: 'archive refused while waiting',
        source: SOURCE,
      });
    });
  });
}
