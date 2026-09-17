import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { gotoHydrated } from '../hydration';
import { pressNextTabStop } from '../keyboard';

export { gotoHydrated, pressNextTabStop };
export type { Locator, Page };

export // How a review comment actually gets created, and what the host has to do with
// the resulting event before anything shows up on screen.
//
// The through-line: every creation callback is NOTIFICATION-ONLY. Submitting the
// selection popover fires `onthreadcreate` and changes nothing else — the
// component renders the bindable `threads` array, and only the host can add to
// it. The route pairs that with a page-owned `addThread`/`addComment` reducer
// behind a checkbox so both halves are observable on one page.
//
// Every test takes its own `page` fixture rather than sharing one across a
// describe block: almost everything here mutates threads, the event log, or the
// sidebar, and a shared page would make the order of the tests load-bearing.

const ROUTE = '/exercises/review-comment-creation';

export const CREATION_PARAGRAPH = 'Export actions land in the second release.';

/**
 * The review editor's own selection debounce (`SELECTION_DEBOUNCE_MS` in
 * `review-editor-impl.svelte`). The specs that assert the selection popover
 * did NOT appear run the installed clock past this window, so the assertion
 * is made after the timer would have fired rather than before it.
 */
export const SELECTION_DEBOUNCE_MS = 20;
export const SELECTION_DEBOUNCE_WINDOW_MS = SELECTION_DEBOUNCE_MS * 5;

export async function ready(page: Page): Promise<void> {
  await gotoHydrated(page, ROUTE);
  // Both live ProseMirror surfaces only exist after MarkdownEditor mounts inside
  // its `{#if browser}` guard, so SSR markup alone is not enough to interact.
  await expect(page.locator('.ProseMirror')).toHaveCount(2);
}

/**
 * Drag-select across `target`, horizontally, at its vertical midpoint.
 *
 * `settle` is clicked first and that is not incidental: ProseMirror scrolls the
 * editor into view when it takes focus, so a bounding box measured before the
 * editor is focused is stale by the time the drag runs — the mouse then lands on
 * whatever moved under those coordinates and selects the wrong range (or
 * nothing). Click somewhere harmless inside the editor, let the scroll settle,
 * and only then measure.
 *
 * The fractions default to the full width because a paragraph is a block box:
 * starting one pixel in lands before the first character and ending one pixel
 * short of the right edge lands past the last one, so the selection is exactly
 * the paragraph's text. Narrower fractions are for dragging *within* an inline
 * span, where the box is only as wide as the text itself.
 */
export async function dragSelect(
  page: Page,
  settle: Locator,
  target: Locator,
  startFraction = 0,
  endFraction = 1,
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await settle.click();
  // "Let the scroll settle" above is not rhetorical: on a busy machine the focus
  // scroll is still running when the click resolves, and a box measured then sends
  // the drag across the wrong pixels — which shows up downstream as a selection
  // that stops mid-word, or as no popover at all.
  //
  // So wait for the thing the sentence actually describes. Two consecutive
  // `boundingBox()` reads agreeing means the element did not move across a full
  // polling interval, which is the literal definition of "the scroll settled" —
  // where the 60ms this used to sleep was a guess at how long that takes, and one
  // that a slower machine could outlast without anything noticing. There is
  // nothing to be padded here: the condition is the measurement itself, and if
  // the element never stops moving the poll times out rather than measuring
  // something wrong.
  let previousBox: string | null = null;
  await expect
    .poll(async () => {
      const serialized = JSON.stringify(await target.boundingBox());
      const settled = serialized !== 'null' && serialized === previousBox;
      previousBox = serialized;
      return settled;
    })
    .toBe(true);
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height / 2;
  const startX = box!.x + Math.max(1, box!.width * startFraction);
  const endX = box!.x + Math.min(box!.width - 1, box!.width * endFraction);
  await page.mouse.move(startX, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(startX + ((endX - startX) * step) / 8, y);
  }
  await page.mouse.up();
}

/** Select the creation editor's second paragraph with the mouse. */
export async function selectCreationParagraph(page: Page): Promise<void> {
  const paragraph = page.locator('#creation-editor .ProseMirror p').nth(1);
  await dragSelect(page, paragraph, paragraph);
  await expect(page.locator('#creation-editor-selection-popover')).toBeVisible();
}

/**
 * Select the creation editor's first three characters ("The") with the keyboard,
 * leaving the selection's focus end after them.
 *
 * The click is setup, not an assertion: it parks a collapsed caret before the
 * first character so the Shift+ArrowRight run selects a known three characters.
 * One pixel inside the paragraph's left edge is what does it — the paragraph is a
 * block box, so that x lands left of the first glyph and the caret has nowhere to
 * go but offset 0, whatever the font metrics.
 *
 * Installing the caret with `document.createRange` instead looks equivalent and
 * is not: ProseMirror never learns about a selection written behind its back, so
 * it reverts the DOM selection out from under the arrow keys and the selection
 * stays collapsed. (Measured in Playwright — the popover never opens, which is
 * exactly how the first test below used to fail.)
 */
export async function keyboardSelectFirstWord(page: Page): Promise<void> {
  const paragraph = page.locator('#creation-editor .ProseMirror p').first();
  await paragraph.scrollIntoViewIfNeeded();
  const box = await paragraph.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + 1, box!.y + box!.height / 2);
  await expect(page.locator('#creation-editor .ProseMirror')).toBeFocused();
  // ProseMirror reconciles selection 20ms after focus. Drain that known timer
  // before arrow input so it cannot restore the setup caret over a new range.
  await page.clock.runFor(20);
  await expectEditorSelection(page, 1, 1);
  for (let keypress = 0; keypress < 3; keypress += 1) {
    await page.keyboard.press('Shift+ArrowRight');
    await expectEditorSelection(page, 1, keypress + 2);
  }
  // Proof the setup landed where it says it did, so a caret that drifted can
  // never be mistaken for the component failing to notice a keyboard selection.
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('The');
}

/** Observe the editor's public state; DOM selection alone can lead it. */
export async function expectEditorSelection(page: Page, from: number, to: number): Promise<void> {
  await expect
    .poll(() =>
      page.getByTestId('creation-host').evaluate((host) => {
        const selection: unknown = Reflect.get(host, 'reviewEditorSelection');
        if (typeof selection !== 'object' || selection === null) return null;
        return { from: Reflect.get(selection, 'from'), to: Reflect.get(selection, 'to') };
      }),
    )
    .toEqual({ from, to });
}

/** Re-select the same first word with a pointer double-click after dismissing it. */
export async function doubleClickSelectFirstWord(page: Page): Promise<void> {
  const paragraph = page.locator('#creation-editor .ProseMirror p').first();
  await paragraph.scrollIntoViewIfNeeded();

  const wordBox = await paragraph.evaluate((element) => {
    const text = element.firstChild;
    if (!(text instanceof Text)) throw new Error('Expected the first paragraph text node');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });

  await page.mouse.dblclick((wordBox.left + wordBox.right) / 2, wordBox.y);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('The');
}

/** Expand the selection popover, type `body`, and submit it. */
export async function submitSelectionComment(page: Page, body: string): Promise<void> {
  const popover = page.locator('#creation-editor-selection-popover');
  await popover.getByRole('button', { name: 'Add comment' }).click();
  await popover.getByRole('textbox', { name: 'Comment text' }).fill(body);
  await popover.getByRole('button', { name: 'Submit comment' }).click();
}

/**
 * Wait for the selection popover to be gone after a submit.
 *
 * Submitting restores focus to the editor, and ProseMirror re-writes its stored
 * (still non-collapsed) selection into the DOM on focus. The editor remembers
 * the range it just turned into a thread and ignores that restored selection,
 * so the popover does not come back over the text that was just commented on
 * (`review-editor-impl.svelte`, `consumedSelection`). The earlier version of
 * this helper collapsed the selection with ArrowRight instead, which raced
 * ProseMirror's own deferred focus-handler `selectionToDOM` (~20ms after
 * focus): when the key landed inside that window the caret move was overwritten
 * by the restored range, nothing ever collapsed, and the popover stayed — the
 * WebKit flake in CIN-515. Nothing is pressed here any more; the count is the
 * whole assertion — hence the name: this waits for the popover to be gone, it
 * does not make it go.
 */
export async function expectSelectionPopoverGone(page: Page): Promise<void> {
  await expect(page.locator('#creation-editor .ProseMirror')).toBeFocused();
  await expect(page.locator('#creation-editor-selection-popover')).toHaveCount(0);
}

/**
 * The shape the page logs. Deliberately all-optional and structural rather than
 * the package's own `ThreadCreateEvent`/`CommentCreateEvent`: several assertions
 * here are about a field being ABSENT, which a required type would hide.
 */
export type LoggedPayload = {
  requestId?: string;
  threadId?: string;
  body?: string;
  authorId?: string;
  mentions?: string[];
  anchor?: {
    type?: string;
    quote?: string;
    originalQuote?: string;
    prefix?: string;
    suffix?: string;
    status?: string;
    from?: number;
    to?: number;
  };
};

/** Read one logged callback payload back off the page. */
export async function loggedPayload(page: Page, index = 0): Promise<LoggedPayload> {
  const raw = await page.getByTestId('event-entry').nth(index).getAttribute('data-json');
  expect(raw).not.toBeNull();
  const parsed: unknown = JSON.parse(raw ?? 'null');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected logged payload to be an object.');
  }
  return parsed;
}
