import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { gotoHydrated } from '../hydration';
import { pressNextTabStop } from '../keyboard';

export { gotoHydrated, pressNextTabStop };
export type { Page };

export // ROADMAP ME-1: the standalone MarkdownEditor at
// `@repo/editor/markdown-editor` — the component ReviewEditor composes,
// and the one whose seven imperative methods this repo had never driven directly.
//
// What is worth knowing before reading the assertions, because the method names
// mislead in three places:
//
//  1. `getSelection()` returns ProseMirror positions and NOTHING else. The
//     `sourcePosition` field its own type declares is never populated by this
//     component, and there is no `doc.textBetween()` offset in the return value —
//     unlike a ReviewEditor anchor, which carries both spaces in one object. The
//     offset here is derived by the page, and the two numbers are asserted side
//     by side precisely so they cannot be conflated.
//  2. `getAst()` depends on a SECOND async path. `data-ready` reports the
//     Milkdown attachment; the mdast pipeline arrives on an unrelated dynamic
//     import and nothing sequences them, so `getAst()` can throw after the editor
//     is demonstrably ready.
//  3. The `plugins` prop is read once, under `untrack()`, when the editor
//     attachment is created. It looks reactive and is not.
//
// Two upstream fixes are pinned here on the component that actually implements
// them rather than through ReviewEditor, which is where this repo pinned them
// before: `aria-readonly` mirroring (cinder#1292) lives in
// `dist/editor/editor.js`'s `applyReadonlyAria`, and the live-selection
// notification (cinder#1289) in the same file's selection listener. Driving them
// through ReviewEditor proves the composition forwards a prop; driving them here
// proves the base component owns the behaviour.

const ROUTE = '/exercises/markdown-editor';

export const MAIN_ID = 'markdown-editor-main';
export const READONLY_ID = 'markdown-editor-readonly';

export const HEADING = 'Release Plan';
export const PARAGRAPH_ONE =
  'The first release includes a dashboard, export actions, and inline review.';
export const PARAGRAPH_TWO =
  'Reviewers should verify that the export dialog copy matches the product brief before we ship.';
export const PARAGRAPH_THREE = 'Timeline risk: the migration script is untested.';
export const INITIAL = `### ${HEADING}\n\n${PARAGRAPH_ONE}\n\n${PARAGRAPH_TWO}\n\n${PARAGRAPH_THREE}`;
export const REPLACEMENT = '# Replaced Plan\n\nOnly one paragraph now.';

export const MARKER = 'dashboard';
export const PROBE_A = 'me-probe-a';
export const PROBE_B = 'me-probe-b';

export // Duplicated from the page's fixture comment on purpose: these are independent
// arithmetic claims about the same document, not readouts of a number the
// component produced. `doc.content.size` of 235 is the empirical check on all of
// them — if the markdown parser built a different node structure, no other
// position below could be right either.
const QUOTE_FROM = 44;
export const QUOTE_TO = 53;
export const QUOTE_OFFSET = 42;
export const HEADING_FROM = 1;
export const HEADING_TO = 13;
export const DOC_SIZE = 235;

export type SelectionReadout = {
  selection: { from: number; to: number; isCollapsed: boolean } | null;
  sourcePosition: unknown;
  derived: { offset: number; length: number; quote: string } | null;
};

export type AstReadout = {
  type: string | null;
  children: { type: string; depth: number | null; text: string }[];
};

export // `.trim()` on both, because a readout whose expression prettier wraps onto its
// own line carries the surrounding indentation inside the element. `JSON.parse`
// tolerates that and `split('|')` emphatically does not — an untrimmed empty
// events readout returns `['\n\t\t']` rather than `[]`, which is a green
// "cleared" assertion over a list that was never read correctly.
const json = async <T>(page: Page, testId: string): Promise<T> =>
  JSON.parse(((await page.getByTestId(testId).textContent()) ?? '').trim() || 'null');

export const selectionEvents = async (page: Page): Promise<string[]> => {
  const raw = ((await page.getByTestId('selection-events').textContent()) ?? '').trim();
  return raw.length ? raw.split('|') : [];
};

/**
 * Navigate and wait until BOTH editors have mounted.
 *
 * Called per test rather than from a file-level `beforeEach`, because the SSR
 * test below reads raw bytes and must not pay for two Milkdown boots to do it.
 * The gate itself is not optional: every control on the page reaches through
 * `bind:this`, and a call made before the attachment reports in returns null
 * readouts that read exactly like component defects.
 */
export async function ready(page: Page): Promise<void> {
  await gotoHydrated(page, ROUTE);
  await expect(page.locator('[data-testid="main-editor"][data-ready="true"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="readonly-editor"][data-ready="true"]')).toHaveCount(1);
  await expect(page.locator(`#${MAIN_ID} .ProseMirror`)).toBeVisible();
  await expect(page.locator(`#${READONLY_ID} .ProseMirror`)).toBeVisible();
}

/**
 * Read the AST, retrying until the markdown pipeline has resolved.
 *
 * This polls an OBSERVABLE condition — the `ast-error` readout emptying — rather
 * than sleeping past a guess. It exists because pipeline readiness has no signal
 * of its own: `data-ready` (already asserted by `ready`) reports the Milkdown
 * attachment, and the pipeline is a separate dynamic import that can land after
 * it. A single click here would be legitimately flaky, and the flake would read
 * as a component defect rather than as the documented trap it is.
 *
 * Both halves of the condition are load-bearing. `ast-error` starts empty, so an
 * "error is empty" poll alone would be satisfied by a sample taken before the
 * first click's outcome reached the DOM — and the caller would then read a
 * `null` AST and fail for a reason that has nothing to do with the pipeline.
 */
export async function readAstWhenReady(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      await page.getByTestId('read-ast').click();
      return {
        error: await page.getByTestId('ast-error').textContent(),
        parsed: (await page.getByTestId('ast-json').textContent()) !== 'null',
      };
    })
    .toEqual({ error: '', parsed: true });
}
