import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { gotoHydrated } from '../hydration';

export { gotoHydrated };
export type { Locator, Page };

export // ROADMAP DV-1 / DV-2 / DV-3 — `DiffViewer` from `@repo/editor/diff-viewer`,
// mounted directly instead of through `ReviewEditor`'s diff view.
//
// Three things here are pinned as PRESENT-TENSE BEHAVIOUR rather than as things
// that ought to be true, and each is flagged where it appears: the window-level
// key bindings firing on every instance at once (DV-3), the hardcoded
// `id="diff-view-mode"` repeating once per default toolbar, and `getHunks()`
// returning nothing for a front-matter-only edit that the toolbar reports as a
// change. If any of those goes red after an upstream release, the fix has
// arrived — the assertion is the notification, which is why none of them is
// written loosely enough to survive it.
//
// Every expected hunk shape below was derived by running the shipped
// `computeLineDiff` / `groupIntoHunks` over the exact fixture strings the page
// builds, not by reading the algorithm and predicting. That matters most for the
// `modified` vs `added`+`removed` split, which depends on diff-match-patch's
// `diff_cleanupSemantic` output and is not obvious from the source.
//
// No `pressNextTabStop` here, deliberately: nothing in this file asserts a Tab
// ORDER. The focus states DV-3 needs are set directly (`locator.focus()`, or a
// click on a non-focusable region), so the WebKit plain-Tab divergence that
// helper documents never comes into it.

const ROUTE = '/exercises/diff-viewer';

export function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} was not produced.`);
  return value;
}

export type HunkRow = {
  index: number;
  originalStart: number;
  originalCount: number;
  currentStart: number;
  currentCount: number;
  lines: number;
  originalLines: number;
  currentLines: number;
};

export // Two changed lines, twelve line-indices apart — beyond the `2 * CONTEXT_LINES`
// merge window — so they stay two hunks. Each carries three context lines on the
// side that has room: the first hunk starts at document line 1 because there are
// only two lines above the change.
const HUNKS_TWO: HunkRow[] = [
  {
    index: 0,
    originalStart: 1,
    originalCount: 6,
    currentStart: 1,
    currentCount: 6,
    lines: 6,
    originalLines: 1,
    currentLines: 1,
  },
  {
    index: 1,
    originalStart: 12,
    originalCount: 4,
    currentStart: 12,
    currentCount: 4,
    lines: 4,
    originalLines: 1,
    currentLines: 1,
  },
];

export // Every change index inside one merge window, so the whole 15-line body is a
// single hunk. Twelve of those lines changed; the three blank lines did not.
const HUNKS_ALL: HunkRow[] = [
  {
    index: 0,
    originalStart: 1,
    originalCount: 15,
    currentStart: 1,
    currentCount: 15,
    lines: 15,
    originalLines: 12,
    currentLines: 12,
  },
];

export // One insertion and one deletion. Note the asymmetric counts — an added line
// exists only in `current`, so the first hunk spans 6 original lines and 7
// current ones, and its `originalLines` array is empty.
const HUNKS_ADDED_AND_REMOVED: HunkRow[] = [
  {
    index: 0,
    originalStart: 2,
    originalCount: 6,
    currentStart: 2,
    currentCount: 7,
    lines: 7,
    originalLines: 0,
    currentLines: 1,
  },
  {
    index: 1,
    originalStart: 11,
    originalCount: 5,
    currentStart: 12,
    currentCount: 4,
    lines: 5,
    originalLines: 1,
    currentLines: 0,
  },
];

export const HUNKS_B: HunkRow[] = [
  {
    index: 0,
    originalStart: 1,
    originalCount: 5,
    currentStart: 1,
    currentCount: 5,
    lines: 5,
    originalLines: 3,
    currentLines: 3,
  },
];

export // The authored front matter, line for line. This is the regression pin for the
// corruption the export pipeline shipped once: a whole document handed to
// `normalize()` came back with the opening `---` re-read as a thematic break and
// the YAML as a setext heading — blank lines injected, sequence-item indentation
// flattened, every subsequent line number shifted. `'  - dana'` with its two
// leading spaces is the assertion that catches that first.
const FRONT_MATTER_UNCHANGED = [
  '---',
  'title: Release Plan',
  'owner: platform',
  'reviewers:',
  '  - dana',
  '  - kit',
  '---',
];

export const viewer = (page: Page, name: string): Locator => page.getByTestId(`viewer-${name}`);

/**
 * A viewer's BODY rows only.
 *
 * The child combinator is load-bearing. `DiffFrontMatter` renders its own
 * `.diff-line` elements nested inside `.front-matter-content`, so a descendant
 * selector would fold eight front-matter rows into every body count and make the
 * front-matter/body split — the thing DV-1's most interesting assertion rests on
 * — invisible.
 */
export const bodyLines = (page: Page, name: string): Locator =>
  viewer(page, name).locator('.diff-content > .diff-line');

/**
 * Body lines that actually carry text.
 *
 * DiffViewer renders exactly one EMPTY `.diff-line` before it has computed
 * anything — measured on both the manual-tier control and the override, which
 * report `{count: 1, withText: 0}` apiece. So "nothing was computed" cannot be
 * expressed as `bodyLines(...).toHaveCount(0)`; that counts a placeholder node
 * and reads as a diff that exists.
 *
 * Filtering on text is the same claim stated accurately, and it is strictly
 * stronger than the count was: a line that rendered real content would be
 * caught here, where a count could be satisfied by any single node.
 */
export const bodyLinesWithText = (page: Page, name: string): Locator =>
  viewer(page, name).locator('.diff-content > .diff-line').filter({ hasText: /\S/ });

/**
 * The UNCHANGED front-matter rows, whose text can be compared byte for byte.
 *
 * `:not([data-selected])` is what makes byte-exactness safe. A `same` row is
 * `<span class="diff-text">{text}</span>` — one expression, no surrounding
 * template whitespace, so `textContent` is exactly the document's line, leading
 * spaces and all. A CHANGED row wraps its text in an `{#if}` over the view mode
 * and so may carry compiler-inserted whitespace, which would make a byte-exact
 * comparison a test of Svelte's whitespace handling rather than of the diff
 * pipeline. `DiffLine` renders `data-selected` on changed rows only, which
 * separates them cleanly.
 */
export const unchangedFrontMatterText = (page: Page, name: string): Locator =>
  viewer(page, name).locator('.front-matter-content .diff-line:not([data-selected]) .diff-text');

export const changedFrontMatterText = (page: Page, name: string): Locator =>
  viewer(page, name).locator('.front-matter-content .diff-line[data-selected] .diff-text');

export const changeCounter = (page: Page, name: string): Locator =>
  viewer(page, name).locator('.change-counter');

export const modeRadio = (page: Page, name: string, label: string): Locator =>
  viewer(page, name).getByRole('radio', { name: label });

export async function expectHunks(page: Page, testId: string, expected: HunkRow[]): Promise<void> {
  await expect
    .poll(async () => JSON.parse((await page.getByTestId(testId).textContent()) ?? 'null'))
    .toEqual(expected);
}

/**
 * Park focus on `<body>`, and confirm it landed there rather than assuming it.
 *
 * DV-3's whole claim is about what happens when focus is OUTSIDE every viewer.
 * If a click quietly left focus on some element inside one of them, the test
 * would still pass and would be measuring something else entirely.
 */
export function normalizeCounterText(text: string | null): string | undefined {
  return text?.trim().replace(/\s+/g, ' ');
}

export async function focusDocumentBody(page: Page): Promise<void> {
  await page.getByTestId('neutral-region').click();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
}

/**
 * The state DV-3's key presses are supposed to move, read in one shot so a
 * "nothing happened" assertion compares whole snapshots rather than four
 * independent values that could drift apart.
 */
export async function keyboardState(page: Page) {
  return {
    counterA: normalizeCounterText(await changeCounter(page, 'a').textContent()),
    counterB: normalizeCounterText(await changeCounter(page, 'b').textContent()),
    modeA: await page.getByTestId('mode-a').textContent(),
    modeB: await page.getByTestId('mode-b').textContent(),
  };
}
