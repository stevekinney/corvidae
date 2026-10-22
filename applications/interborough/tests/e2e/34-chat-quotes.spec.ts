/**
 * Quoting parts of an agent's replies and answering them (COR-1567), against the real host. The
 * seeded `echo` agent repeats the user message it received, so what it says back is what the model
 * was given: two excerpts, quoted from two different replies, arrive as two Markdown block quotes
 * in the order they were quoted, ahead of the typed text. The case runs at a phone's width and a
 * desktop's, with axe passing on the open Quote popover, the chips, and the reloaded transcript.
 */
import type { Locator, Page } from '@playwright/test';

import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;

const FIRST_QUESTION = 'The first item is alpha.';
const SECOND_QUESTION = 'The second item is bravo.';
const FIRST_EXCERPT = 'first item';
const SECOND_EXCERPT = 'second item';
const TYPED = 'Which of these comes first?';

const QUOTE_POPOVER = '[role="toolbar"][aria-label="Quote selection"]';
const ASSISTANT_ROW = '[data-message-role="assistant"]';
const USER_ROW = '[data-message-role="user"]';

/** Selects `text` inside the nth assistant message's rendered text, as a drag across it would. */
async function selectInReply(page: Page, index: number, text: string): Promise<void> {
  await page.evaluate(
    ({ index: replyIndex, text: wanted }) => {
      const sources = document.querySelectorAll(
        '[data-message-role="assistant"] [data-quote-source]',
      );
      const source = sources[replyIndex];
      if (source === undefined) throw new Error(`There is no reply ${replyIndex}.`);
      const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const start = node.textContent?.indexOf(wanted) ?? -1;
        if (start === -1) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + wanted.length);
        const selection = window.getSelection();
        if (selection === null) throw new Error('The page has no selection.');
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      throw new Error(`"${wanted}" is not in reply ${replyIndex}.`);
    },
    { index, text },
  );
}

/** The text of each block quote in `row`, in the order it appears. */
async function quotesOf(row: Locator): Promise<string[]> {
  const texts = await row.locator('blockquote').allTextContents();
  return texts.map((text) => text.trim());
}

for (const viewport of VIEWPORTS) {
  test(`quotes two excerpts from two replies and sends them, at ${viewport.width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    const threadId = newThreadId('quote');
    await runToEnd(request, 'echo', threadId, FIRST_QUESTION);
    await runToEnd(request, 'echo', threadId, SECOND_QUESTION);
    await page.goto(`/chat/${threadId}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    const replies = page.locator(ASSISTANT_ROW);
    await expect(replies).toHaveCount(2);
    await expect(replies.first()).toContainText(FIRST_QUESTION);
    await expect(replies.last()).toContainText(SECOND_QUESTION);

    // Part of the first reply is selected, and the popover offers to quote it.
    const chips = page.getByRole('list', { name: 'Quoted excerpts' }).getByRole('listitem');
    const popover = page.locator(QUOTE_POPOVER);
    await selectInReply(page, 0, FIRST_EXCERPT);
    await expect(popover.getByRole('button', { name: 'Quote' })).toBeVisible();
    await checkA11y(`the Quote popover, at ${viewport.width} pixels`);
    await popover.getByRole('button', { name: 'Quote' }).click();
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText(FIRST_EXCERPT);

    // A second excerpt comes from the other reply, and is added after the first.
    await selectInReply(page, 1, SECOND_EXCERPT);
    await popover.getByRole('button', { name: 'Quote' }).click();
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toContainText(SECOND_EXCERPT);
    await checkA11y(`two quoted excerpts, at ${viewport.width} pixels`);

    await page.getByRole('textbox').fill(TYPED);
    await page.getByRole('textbox').press('Enter');

    // The echo says what it received: both block quotes in order, then the typed text.
    await expect(replies).toHaveCount(3);
    await expect(replies.last()).toContainText(TYPED);
    expect(await quotesOf(replies.last())).toEqual([FIRST_EXCERPT, SECOND_EXCERPT]);
    const echoed = (await replies.last().textContent()) ?? '';
    expect(echoed.indexOf(FIRST_EXCERPT)).toBeLessThan(echoed.indexOf(SECOND_EXCERPT));
    expect(echoed.indexOf(SECOND_EXCERPT)).toBeLessThan(echoed.indexOf(TYPED));
    // The chips left with the send, and the person's own row shows the same two quotes.
    await expect(chips).toHaveCount(0);
    expect(await quotesOf(page.locator(USER_ROW).last())).toEqual([FIRST_EXCERPT, SECOND_EXCERPT]);

    // Reloaded, the thread shows the sent message with both excerpts as block quotes.
    await page.reload();
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator(USER_ROW)).toHaveCount(3);
    const sent = page.locator(USER_ROW).last();
    await expect(sent).toContainText(TYPED);
    expect(await quotesOf(sent)).toEqual([FIRST_EXCERPT, SECOND_EXCERPT]);
    await checkA11y(`the reloaded quoted message, at ${viewport.width} pixels`);
  });
}
