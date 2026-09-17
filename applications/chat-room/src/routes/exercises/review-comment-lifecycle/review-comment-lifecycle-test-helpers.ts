import type { ElementHandle, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { gotoHydrated } from '../hydration';

export { gotoHydrated };
export type { ElementHandle, Locator, Page };

export // Pins the READ and MUTATE halves of ReviewEditor's comment surface: the
// sidebar, the thread popover, and the four notification-only callbacks
// (`oncommentcreate` / `oncommentupdate` / `oncommentdelete` / `onthreaddelete`)
// against the page-owned reducer that actually moves `threads`.
//
// Thread creation lives in `review-comment-creation`, and the anchor-decoration
// story in `review-anchoring`; both need fixtures this route cannot have.
//
// Every test starts from a fresh page: the fixture is mutated by most of these
// flows, and a shared page would make each test depend on the ones before it.
const ROUTE = '/exercises/review-comment-lifecycle';

export function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} was not produced.`);
  return value;
}
export // Literals, not recomputations. The component's truncation budgets are 60 for
// the sidebar quote, 80 for the sidebar preview, and 30 for the popover title —
// re-deriving them here with a slice would assert the spec against itself
// instead of against the component. Note the two different ellipses: `truncate`
// uses the single character '…', the popover title hand-rolls three dots.
const FULL_QUOTE = 'Reviewers should verify that the export dialog copy matches the product brief';
export const SIDEBAR_QUOTE_60 = 'Reviewers should verify that the export dialog copy matches…';
export const SIDEBAR_PREVIEW_80 =
  'This paragraph is the sentence legal asked us to re-read line by line before th…';
export const POPOVER_TITLE_30 = '"Reviewers should verify that t..."';
export const sidebar = (page: Page) => page.locator('#lifecycle-editor-sidebar');
export const popover = (page: Page) => page.locator('#lifecycle-editor-thread-popover');
export const commentsToggle = (page: Page) =>
  page.getByRole('button', { name: /comments sidebar/ });
export const threadRows = (page: Page) => sidebar(page).locator('button.thread-item');
export const badge = (page: Page) => page.locator('.comments-toggle-wrapper .cinder-badge');
export const announcer = (page: Page) => page.locator('.comments-count-announcer');
export // Row lookups go by content, never by index: rows disappear from under you as
// threads turn into ghosts, and the surviving rows shift up.
const rowQuoted = (page: Page, quote: string) =>
  threadRows(page).filter({ has: page.locator('blockquote.thread-quote', { hasText: quote }) });
export const docRow = (page: Page) => threadRows(page).filter({ hasText: 'Document comment' });
export async function openSidebar(page: Page): Promise<void> {
  await commentsToggle(page).click();
  await expect(sidebar(page)).toBeVisible();
}
/**
 * Select a thread from the sidebar and wait for its popover.
 *
 * Selection opens the popover on a ~350ms timer (POSITION_DELAY_MS) and then
 * floating-ui positions it on a later frame, so the popover exists before it is
 * usable. `data-position-ready` is the settled signal — until it flips, the
 * dialog carries `inert` and swallows every click.
 *
 * A plain default-centre click. This used to be offset to the row's top-left
 * to dodge the `Observed state` section painting over the longest-quote row —
 * a real defect for a mouse user, not just this spec, since it happened in
 * every browser. `+page.svelte`'s editor wrapper now scrolls its own overflow
 * instead of spilling into the next section, so nothing covers this row and a
 * default click exercises the same path a real reviewer's pointer would.
 */
export async function selectThread(page: Page, row: Locator): Promise<Locator> {
  await row.click();
  const dialog = popover(page);
  await expect(dialog).toHaveAttribute('data-position-ready', 'true');
  await expect(dialog).toHaveJSProperty('inert', false);
  return dialog;
}
/** Every logged payload for one callback name, parsed. */
export async function payloadsFor(page: Page, name: string): Promise<Record<string, unknown>[]> {
  const rows = await page.getByTestId('event-log').locator('li').allTextContents();
  return rows
    .filter((row) => row.startsWith(`${name} `))
    .map((row) => {
      const parsed: unknown = JSON.parse(row.slice(name.length + 1));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Expected event payload to be an object.');
      }
      return Object.fromEntries(Object.entries(parsed));
    });
}

/**
 * Record every distinct value of `.thread-popover-quote`'s text, from now on.
 *
 * Attached to the popover's own root, not a page-wide ancestor: this
 * component's `{#if popoverThread && popoverPosition}` block has no `{#key}`,
 * so the SAME `ThreadPopover` instance survives a `popoverThreadId` change —
 * its `thread` prop just updates in place, and the quote's text node mutates
 * rather than getting replaced by a new element. That makes the popover
 * `dialog` already resolves to at test start the right `MutationObserver`
 * target for every quote it will ever show, including one that appears and
 * reverts before any polled read could land on either edge.
 */
export async function watchPopoverQuote(dialog: Locator): Promise<void> {
  await dialog.evaluate((element) => {
    const trace: string[] = [];
    Reflect.set(window, '__quoteTrace', trace);
    const record = () => {
      const quote = element.querySelector('.thread-popover-quote');
      const text = quote ? quote.textContent : null;
      if (text !== null && trace[trace.length - 1] !== text) trace.push(text);
    };
    record();
    new MutationObserver(record).observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}
/** Every distinct quote `watchPopoverQuote` has recorded so far, in order. */
export function popoverQuoteTrace(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const trace = Reflect.get(window, '__quoteTrace');
    return Array.isArray(trace) && trace.every((entry) => typeof entry === 'string') ? trace : [];
  });
}
