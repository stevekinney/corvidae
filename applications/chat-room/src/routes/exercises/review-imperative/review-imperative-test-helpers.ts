import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { gotoHydrated } from '../hydration';

export { gotoHydrated };
export type { Page };

export // ROADMAP RE-1: the eight thread and comment mutation methods on ReviewEditor's
// imperative surface, driven through `bind:this`.
//
// Two things this suite pins that are easy to get wrong by reading the types:
//
//  1. These methods are REQUESTS, not mutations. Each fires a callback and
//     changes nothing itself; `threads` only moves because the page owns a
//     reducer. A test that asserted only the return value would pass against a
//     component that never notified anyone.
//  2. `createThread` gates on `currentSelection` — a private `$state` fed by the
//     inner MarkdownEditor's `onselectionchange` — and NOT on the view-derived
//     `getSelection()`. Those two agree only as of
//     `@repo/editor@0.9.1`. Before it, the listener re-read `view.state`
//     from inside `EditorState.apply`, so `currentSelection` lagged the live
//     selection by exactly one selection-changing transaction: a single
//     dispatch returned null, and a mouse drag silently anchored short of what
//     was highlighted. That was cinder#1288, fixed by cinder#1289. Both halves
//     are pinned below against the FIXED contract — one dispatch is now enough,
//     and a native drag anchors exactly the range it covered — so both go red
//     against 0.9.0.

// ROADMAP RE-3 and RE-4 live in the last two describe blocks, against two
// FURTHER instances on the same route — `#imperative-content` for `setMarkdown`,
// `reset`, `getMarkdown` and `getAst`, `#imperative-tall` for `scrollToThread`
// and `getEditor`. The page's header comment explains why they are separate
// instances rather than more buttons on the two above.
//
// RE-4's `scrollToThread` bugs (cinder#1316, cinder#1317) are FIXED and
// VERIFIED as of `@repo/editor@0.11.0`, and the two tests below are
// retargeted against the fixed contract: `scrollToThread` now reaches the
// same anchor `scroll-into-view-control` already reached, and an unknown
// thread id throws rather than returning silently indistinguishable from a
// successful call. (Focus still does not move either way, which is unchanged
// and not one of the two bugs that were fixed.)
//
// That same 0.11.0 bump introduced a NEW regression in RE-3's `reset()`:
// once `setMarkdown` had been called on an editor instance, a later `reset()`
// no longer reached the live document. Filed as stevekinney/cinder#1328,
// FIXED and VERIFIED as of `@repo/editor@0.12.0` — the two tests in
// the content-replacement block below are retargeted against the fixed
// contract. See those tests themselves for the mechanism.

const ROUTE = '/exercises/review-imperative';

export const PARAGRAPH_THREE = 'Timeline risk: the migration script is untested.';

export // Restated from the page rather than imported, the same way `PARAGRAPH_THREE`
// above is: a `.svelte` module cannot export a constant to a spec, and a shared
// constants module would let the fixture and the expectation drift together —
// the spec would keep passing while the document it describes changed.
const CONTENT_HEADING = 'Content Replacement Fixture';
export const CONTENT_ORIGINAL_HEADING = 'Content Baseline';
export const CONTENT_REPLACEMENT =
  '### Content Replacement Fixture\n\n' +
  'A late addition pushes the rest of the document down.\n\n' +
  'The rollout plan names a dashboard owner and a migration owner.\n\n' +
  'The deployment window is now agreed.';
export const SURVIVING_QUOTE = 'dashboard owner';
export const REMOVED_QUOTE = 'rollback checklist';
export const TALL_QUOTE = 'migration script';
export const TALL_ORPHAN_ID = 'tall-orphan-1';

export type AnchorRow = {
  id: string;
  type: string;
  /** What the component actually reported, before the page's `?? 'text'`. */
  rawType: string | null;
  /** The component's real block marker — see the block-thread test. */
  blockId: string | null;
  quote: string;
  from: number | null;
  to: number | null;
  lastKnownOffset: number | null;
  status: string | null;
  comments: number;
};

export function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} was not produced.`);
  return value;
}

export async function firstAnchor(page: Page, label = 'anchor row'): Promise<AnchorRow> {
  const rows = await anchors(page);
  return defined(rows[0], label);
}

export async function anchors(page: Page): Promise<AnchorRow[]> {
  return JSON.parse((await page.getByTestId('anchors-json').textContent()) ?? '[]');
}

/** The independent textBetween derivation, taken from ProseMirror by the page. */
export async function probe(page: Page): Promise<(number | null)[]> {
  return JSON.parse((await page.getByTestId('probe-json').textContent()) ?? '[]');
}

export async function events(page: Page): Promise<string[]> {
  const raw = (await page.getByTestId('events').textContent()) ?? '';
  return raw.length ? raw.split('|') : [];
}

export const threadCount = (page: Page) => page.getByTestId('thread-count');
export const lastReturn = (page: Page) => page.getByTestId('last-return');

/**
 * Read a readout that the page renders across several template lines.
 *
 * `textContent()` is raw, so those carry the surrounding newlines and tabs while
 * the single-line readouts above do not. `JSON.parse` tolerates that; a bare
 * string comparison does not, which is the one that silently fails.
 */
export async function readoutText(page: Page, testId: string): Promise<string> {
  return ((await page.getByTestId(testId).textContent()) ?? '').trim();
}

export async function contentAnchors(page: Page): Promise<AnchorRow[]> {
  return JSON.parse(await readoutText(page, 'content-anchors-json'));
}

export async function tallAnchors(page: Page): Promise<AnchorRow[]> {
  return JSON.parse(await readoutText(page, 'tall-anchors-json'));
}

export async function contentEvents(page: Page): Promise<string[]> {
  const raw = await readoutText(page, 'content-events');
  return raw.length ? raw.split('|') : [];
}

export type MarkdownReport = {
  fromGetMarkdown: string;
  valueProp: string;
  getMarkdownLength: number;
  valuePropLength: number;
};

export async function contentMarkdown(page: Page): Promise<MarkdownReport> {
  return JSON.parse(await readoutText(page, 'content-markdown-json'));
}

export type AstRow = { type: string; depth: number | null; text: string };

/**
 * Click `getAst` and return its projection, retrying until the pipeline answers.
 *
 * `getAst` throws `Markdown pipeline is not ready yet.` until a dynamic
 * `import('@repo/markdown')` resolves, and that import lives in
 * an effect SEPARATE from editor creation — so `data-ready`, which the
 * `beforeEach` gate waits on, does not cover it.
 *
 * Polled by RE-ASKING rather than by sleeping: the observable condition is "the
 * pipeline answered", and the only way to observe it is another call. The
 * `dragSelectFirstParagraph` helper above uses the same shape for the same
 * reason.
 */
export async function readAst(page: Page): Promise<AstRow[]> {
  await expect
    .poll(async () => {
      await page.getByTestId('content-get-ast').click();
      return readoutText(page, 'content-ast-error');
    })
    .toBe('');
  return JSON.parse(await readoutText(page, 'content-ast-json'));
}

/**
 * The rendered block structure of the content editor, projected into the same
 * shape `getAst` reports.
 *
 * Filtered to headings and paragraphs because those are the only node types this
 * fixture contains — comparing against every child would fail on any decoration
 * widget ProseMirror chose to render, which is not what this asserts.
 */
export async function renderedBlocks(page: Page): Promise<AstRow[]> {
  return page
    .locator('#imperative-content .ProseMirror > :is(h1,h2,h3,h4,h5,h6,p)')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const tag = node.tagName.toLowerCase();
        return {
          type: tag === 'p' ? 'paragraph' : 'heading',
          depth: tag === 'p' ? null : Number(tag.slice(1)),
          text: node.textContent ?? '',
        };
      }),
    );
}

export async function probeUndoDepth(page: Page, expectedProbe: number): Promise<number> {
  await page.getByTestId('content-probe-undo').click();
  // The probe counter, not the depth: the depth before and after a reset can
  // legitimately be the same number, so polling on it could not tell a fresh
  // answer from a stale render.
  await expect
    .poll(async () => JSON.parse(await readoutText(page, 'content-undo-json')).probe)
    .toBe(expectedProbe);
  return JSON.parse(await readoutText(page, 'content-undo-json')).depth;
}

export type ScrollSample = {
  winY: number;
  domTop: number;
  scrollerTop: number;
  anchorTop: number | null;
  viewportHeight: number;
  active: string;
};

export type ScrollReport = {
  threadId: string;
  before: ScrollSample;
  after: ScrollSample;
  moved: boolean;
  threw: string | null;
  returned: string;
  calls: number;
  lastCallArgument: string | null;
};

export async function scrollReport(page: Page): Promise<ScrollReport> {
  return JSON.parse(await readoutText(page, 'scroll-json'));
}

export type EditorIdentity = {
  present: boolean;
  status: string | null;
  stableAcrossCalls: boolean;
  distinctFromOtherInstance: boolean;
  actionCtxIsEditorCtx: boolean | null;
  actionThrew: string | null;
  viewDocSize: number | null;
  otherViewDocSize: number | null;
};

export async function editorIdentity(page: Page): Promise<EditorIdentity> {
  return JSON.parse(await readoutText(page, 'editor-identity-json'));
}

/**
 * Press a control by keyboard rather than clicking it.
 *
 * Every RE-4 assertion reads `document.activeElement` back out of the page, and
 * macOS WebKit — which this spec runs in, per `CROSS_ENGINE` in
 * `playwright.config.ts` — does not focus a `<button>` on click. A `.click()`
 * there leaves focus on `<body>` for reasons that have nothing to do with the
 * component, and "focus did not move" would be unfalsifiable in one of the three
 * engines.
 */
export async function pressControl(page: Page, testId: string): Promise<void> {
  const control = page.getByTestId(testId);
  await control.focus();
  await control.press('Enter');
}

/** Seed the RE-3 instance with the surviving thread and the doomed one. */
export async function seedContent(page: Page): Promise<AnchorRow[]> {
  await pressControl(page, 'content-seed');
  await expect(page.getByTestId('content-thread-count')).toHaveText('content threads: 2');
  return contentAnchors(page);
}

/** Seed the RE-4 instance's anchored thread and return its id. */
export async function seedTall(page: Page): Promise<string> {
  await pressControl(page, 'tall-seed');
  await expect(page.getByTestId('tall-thread-count')).toHaveText('scroll threads: 2');

  const tallRows = await tallAnchors(page);
  const anchored = defined(
    tallRows.find((row) => row.id !== TALL_ORPHAN_ID),
    'anchored tall row',
  );
  // The page's hand-derived positions, asserted here rather than taken on trust.
  // The selection that produced this thread was made at literal ProseMirror
  // coordinates; if that arithmetic is wrong the selection covers different
  // text, the thread anchors it, and every measurement below is of the wrong
  // anchor while still looking self-consistent.
  expect(anchored.quote).toBe(TALL_QUOTE);
  expect(anchored.from).toBe(1493);
  expect(anchored.to).toBe(1509);
  expect(anchored.status).toBe('anchored');
  // The thread arrived through the component's own notification rather than
  // being pushed into the array by the page, which is what makes it a real
  // anchor for `scrollToThread` to resolve rather than a fixture object.
  await expect(page.getByTestId('tall-events')).toHaveText(`onthreadcreate:${anchored.id}`);
  return anchored.id;
}

/**
 * Select the first paragraph with a real mouse drag.
 *
 * This used to be a workaround: a drag emits MANY selection transactions, which
 * was the only way past the one-transaction lag cinder#1288 described, and its
 * docblock said the helper should disappear once the fix shipped. It has shipped
 * (`@repo/editor@0.9.1`), and the shared `createAnchored` below no longer
 * drags — it takes the deterministic `getView()` path, so the rest of the suite
 * stops paying bounding-box arithmetic for nothing.
 *
 * The helper survives for ONE caller, deliberately and against its own former
 * advice: `the anchor covers exactly the text a native drag highlighted` is the
 * only test here that exercises Milkdown's real pointer-driven selection
 * pipeline, and the native path is where #1288's severity was worst — it did not
 * merely refuse, it anchored text nobody selected. Deleting the last native
 * assertion because the bug that motivated it was fixed is how the regression
 * comes back unnoticed.
 */
export async function dragSelectFirstParagraph(page: Page): Promise<void> {
  const paragraph = page.locator('#imperative-editor .ProseMirror p').first();
  await paragraph.scrollIntoViewIfNeeded();
  const box = await paragraph.boundingBox();
  expect(box).not.toBeNull();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + 2, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(box!.x + 2 + ((box!.width - 4) * step) / 8, y);
  }
  await page.mouse.up();
  // Polls the view-derived `getSelection()` readout — which is what is
  // observable from here — rather than `currentSelection`, which is private.
  await expect
    .poll(async () => {
      await page.getByTestId('read-selection').click();
      const raw = (await page.getByTestId('selection-json').textContent()) ?? 'null';
      return JSON.parse(raw)?.viaGetSelection?.isCollapsed;
    })
    .toBe(false);
}

/**
 * Put a known, exact selection in the editable view through the public
 * `getView()` — the path `CLAUDE.md`'s `bind:this` guidance implies — and wait
 * until the component reports it.
 *
 * ONE selection-changing dispatch, which is precisely what cinder#1288 made
 * insufficient and cinder#1289 made sufficient.
 */
export async function selectQuote(page: Page): Promise<{ from: number; to: number }> {
  await page.getByTestId('select-quote').click();
  await expect
    .poll(async () => {
      const raw = (await page.getByTestId('selection-json').textContent()) ?? 'null';
      return JSON.parse(raw)?.viaGetSelection?.isCollapsed;
    })
    .toBe(false);
  return JSON.parse((await page.getByTestId('selection-json').textContent()) ?? 'null').view;
}

/**
 * Create one anchored thread through the imperative surface, and return its id.
 *
 * `create-thread-nodomselect` rather than `create-thread`: it takes whatever is
 * already selected instead of selecting for itself, which is the plain consumer
 * path AND the button that records `selection-at-call` for the equality test.
 */
export async function createAnchored(page: Page): Promise<string> {
  await selectQuote(page);
  await page.getByTestId('create-thread-nodomselect').click();
  await expect(threadCount(page)).toHaveText('threads: 1');
  const createdAnchor = await firstAnchor(page, 'created anchor');
  return createdAnchor.id;
}
