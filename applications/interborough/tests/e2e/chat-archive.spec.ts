/**
 * Archiving a chat on the real host (COR-2285 V5): Archive in the chat's More menu, with no question
 * asked, replaces the composer with Chat's neutral Archived bar (the archive glyph, `Archived <date>`,
 * a secondary New chat and the primary Unarchive) and leaves the conversation readable; a reload
 * keeps it; Unarchive brings the composer back with the focus in its box; and a chat that waits on an
 * approval is not archived, and says why. On a desktop the chat list leaves the archived chat out
 * and its Archived segment lists it. A phone's list has no segments (row 06l), so the list part runs
 * at the desktop width alone.
 *
 * Each case starts chats of its own on the main host and deletes them afterwards, so the sample
 * world, which other specs count, is never archived.
 */
import type { Page } from '@playwright/test';

import { CHAT_COPY } from '../../src/app/copy/chat.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, test } from './fixtures.ts';
import { bureauCall } from './task-support.ts';

const SOURCE = 'chat-archive.spec.ts';
const MORE = CHAT_COPY.more;
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

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.width} pixels`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
    });

    test('archives from the More menu: the Archived bar, kept across a reload, and Unarchive brings the composer back', async ({
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
      const newChat = bar.getByRole('link', { name: CHAT_COPY.composer.newChat });
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
      const stored = (await bureauCall(request, 'bureau.contexts.get', {
        contextId: threadId,
      })) as { archivedAt?: string | null };
      expect(typeof stored.archivedAt).toBe('string');
      await checkA11y(`an archived chat at ${viewport.width}px`);
      await captureForDesignReview(page, {
        route: '/chats/:chat',
        state: 'archived',
        source: SOURCE,
      });

      // The archive is the Bureau's, so a reload shows the bar again.
      await page.reload();
      await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
      await expect(archivedBar(page)).toBeVisible();

      // An archived chat's menu offers Unarchive in place of Archive.
      await moreButton(page).click();
      await expect(page.getByRole('menuitem', { name: MORE.unarchive, exact: true })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: MORE.archive, exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menuitem')).toHaveCount(0);

      await archivedBar(page)
        .getByRole('button', { name: CHAT_COPY.composer.unarchive, exact: true })
        .click();
      await expect(archivedBar(page)).toHaveCount(0);
      await expect(composer(page)).toBeFocused();
      const restored = (await bureauCall(request, 'bureau.contexts.get', {
        contextId: threadId,
      })) as { archivedAt?: string | null };
      expect(restored.archivedAt ?? null).toBeNull();
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

test('the list leaves an archived chat out, and the Archived segment lists it, at 1280 pixels', async ({
  page,
  request,
  checkA11y,
}) => {
  // Archived shows beside the three status segments in a pane with room for it.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('interborough-chats', '400');
    } catch {
      // The divider is left where it is.
    }
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const kept = newThreadId('archive-list-kept');
  const archived = newThreadId('archive-list-archived');
  started.push(kept, archived);
  await runToEnd(request, AGENT, archived, 'Put me away');
  await runToEnd(request, AGENT, kept, 'Keep me');
  await bureauCall(request, 'bureau.contexts.archive', { contextId: archived });

  await page.goto('/chats');
  const region = page.getByRole('region', { name: CHAT_COPY.sessionsTitle });
  await expect(region.locator(`[data-chat="${kept}"]`)).toBeVisible();
  await expect(region.locator(`[data-chat="${archived}"]`)).toHaveCount(0);

  const control = region.getByRole('radiogroup', { name: CHAT_COPY.list.segmentsLabel });
  await expect(control.getByRole('radio')).toHaveCount(4);
  // The four segments fit on one line, read in one pass.
  const fit = await control.evaluate((element) => ({
    overflows: element.scrollWidth > element.clientWidth + 1,
    lines: new Set(
      [...element.querySelectorAll('[role="radio"]')].map((radio) =>
        Math.round(radio.getBoundingClientRect().top),
      ),
    ).size,
  }));
  expect(fit).toEqual({ overflows: false, lines: 1 });

  await control.getByRole('radio', { name: CHAT_COPY.list.segments.archived, exact: true }).click();
  await expect(region.locator(`[data-chat="${archived}"]`)).toBeVisible();
  await expect(region.locator(`[data-chat="${kept}"]`)).toHaveCount(0);
  await checkA11y('the Archived segment of the chat list');
  await captureForDesignReview(page, { route: '/chats', state: 'archived', source: SOURCE });

  // Opening the archived chat from its row shows its Archived bar.
  await region.locator(`[data-chat="${archived}"] a`).first().click();
  await expect(page).toHaveURL(new RegExp(`/chats/${archived}$`));
  await expect(archivedBar(page)).toBeVisible();
});
