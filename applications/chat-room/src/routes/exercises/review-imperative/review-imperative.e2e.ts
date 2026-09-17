import { expect, test } from '@playwright/test';
import {
  PARAGRAPH_THREE,
  ROUTE,
  anchors,
  createAnchored,
  dragSelectFirstParagraph,
  events,
  firstAnchor,
  gotoHydrated,
  lastReturn,
  probe,
  selectQuote,
  threadCount,
} from './review-imperative-test-helpers';

test.beforeEach(async ({ page }) => {
  await gotoHydrated(page, ROUTE);
  // Matching the `ready()` gate every other review-* spec uses. Without it this
  // file failed 3 of 8 repeats with `Cannot read properties of null` on the
  // selection readout, and 7 of 55 across the suite — a racy setup that reads as
  // a component bug. All FOUR editors must be up — the two RE-1 instances plus
  // the RE-3 and RE-4 ones — so the count is 4.
  await expect(page.locator('[data-testid="review-editor"][data-ready="true"]')).toHaveCount(4);
  await expect(page.locator('#imperative-editor .ProseMirror')).toBeVisible();
  await expect(page.locator('#imperative-readonly .ProseMirror')).toBeVisible();
  await expect(page.locator('#imperative-content .ProseMirror')).toBeVisible();
  await expect(page.locator('#imperative-tall .ProseMirror')).toBeVisible();
  await expect(threadCount(page)).toHaveText('threads: 0');
});
test.describe('review-imperative: creation', () => {
  test('createThread anchors the selection, and both coordinate spaces agree', async ({ page }) => {
    const id = await createAnchored(page);

    const row = await firstAnchor(page);
    expect(row.id).toBe(id);
    expect(row.type).toBe('text');
    expect(row.status).toBe('anchored');
    expect(row.comments).toBe(1);

    // EXACT, not merely self-consistent. The page's fixture comment derives
    // these by hand — 'dashboard' sits at index 29 of paragraph one, whose
    // ProseMirror content starts at 15 and whose textBetween run starts at 13 —
    // so 44/53 and 42 are three independent arithmetic claims about one
    // selection, not three readouts of the same number. Asserting them became
    // possible only once a single dispatch was enough to anchor at all; the
    // drag this used to take could not name its own range.
    expect(row.quote).toBe('dashboard');
    expect(row.from).toBe(44);
    expect(row.to).toBe(53);
    expect(row.lastKnownOffset).toBe(42);

    // The other half of the block-thread distinction: a text anchor carries no
    // `blockId`. Asserted here rather than only there, so the pair cannot both
    // drift to the same value and keep passing.
    expect(row.rawType).toBeNull();
    expect(row.blockId).toBeNull();

    // COORDINATE SPACE 1 — the rendered decoration. The `.comment-anchor` span
    // must cover exactly the quoted text, not merely overlap it.
    const decoration = page.locator('#imperative-editor .ProseMirror span.comment-anchor');
    await expect(decoration).toHaveCount(1);
    expect((await decoration.textContent()) ?? '').toBe(row.quote);

    // COORDINATE SPACE 2 — `lastKnownOffset` is a doc.textBetween() offset, NOT
    // a ProseMirror position, and the two are different numbers for the same
    // selection. `probe-json` is derived straight from ProseMirror rather than
    // from the component's offset helper — but it is fed the component's own
    // `anchor.from`, so it is independent of the HELPER and not of the anchor.
    // It catches a coordinate-space mixup between two fields of one anchor. It
    // cannot catch an anchor that describes the wrong text, which is exactly
    // why the next test has to exist.
    const [offset] = await probe(page);
    expect(row.lastKnownOffset).toBe(offset);
    expect(row.from).not.toBe(row.lastKnownOffset);
    expect(row.from).toBeGreaterThan(row.lastKnownOffset!);

    expect(await events(page)).toEqual([`onthreadcreate:${id}`]);
  });

  test('the anchor covers exactly the text a native drag highlighted', async ({ page }) => {
    // The native path, kept deliberately — see `dragSelectFirstParagraph`. This
    // is the assertion the coordinate-space test is NAMED for and cannot make:
    // both of that test's comparisons take the anchor as their input (the
    // rendered span against the anchor's own quote, `lastKnownOffset` against a
    // probe derived from the anchor's own `from`), so they hold perfectly while
    // the anchor describes text nobody selected. Only comparing against the
    // selection captured at call time can catch that.
    //
    // REGRESSION PIN for cinder#1288. Against `@repo/editor@0.9.0` this
    // drag selected 15..89 and anchored 15..86 — a silent, wrong-text anchor, the
    // worst of that bug's three symptoms. Equality is the fixed contract.
    await dragSelectFirstParagraph(page);
    await page.getByTestId('create-thread-nodomselect').click();
    await expect(threadCount(page)).toHaveText('threads: 1');

    const row = await firstAnchor(page);
    const selected = JSON.parse(
      (await page.getByTestId('selection-at-call').textContent()) ?? '{}',
    );

    expect(row.from).toBe(selected.from);
    expect(row.to).toBe(selected.to);

    // And the consequence, stated in the terms a user would notice: the quote is
    // the whole highlighted paragraph, not a prefix of it.
    const paragraph =
      (await page.locator('#imperative-editor .ProseMirror p').first().textContent()) ?? '';
    expect(row.quote).toBe(paragraph);
  });

  test('a single programmatic selection through getView() is enough to anchor', async ({
    page,
  }) => {
    // The page selects through the public `getView()` — the path CLAUDE.md's
    // `bind:this` guidance implies — with exactly ONE selection-changing
    // transaction.
    const view = await selectQuote(page);
    expect(view).toEqual({ from: 44, to: 53 });

    await page.getByTestId('create-thread').click();

    // REGRESSION PIN for cinder#1288, the other half. Against 0.9.0 this was a
    // silent null with no thread and no callback: one dispatch left
    // `currentSelection` holding the previous collapsed caret, so the selection
    // guard refused, and `select-quote` + `create-thread` dispatching the same
    // range meant Milkdown suppressed the duplicate and no second notification
    // ever arrived to unstick it. Now the listener is handed the live selection,
    // so one dispatch anchors — at the exact range, which is what separates this
    // from "it returned something".
    await expect(threadCount(page)).toHaveText('threads: 1');
    const row = await firstAnchor(page);
    await expect(lastReturn(page)).toHaveText(`last return: ${row.id}`);
    expect(row.from).toBe(44);
    expect(row.to).toBe(53);
    expect(row.quote).toBe('dashboard');
    expect(await events(page)).toEqual([`onthreadcreate:${row.id}`]);
  });

  test('createDocumentThread is document-typed, quoteless, and sorts ahead of anchored threads', async ({
    page,
  }) => {
    await createAnchored(page);
    await page.getByTestId('create-document-thread').click();
    await expect(threadCount(page)).toHaveText('threads: 2');

    const rows = await anchors(page);
    const documentThread = rows.find((row) => row.type === 'document');
    expect(documentThread).toBeDefined();
    expect(documentThread!.quote).toBe('');
    expect(documentThread!.lastKnownOffset).toBeNull();

    // Sorts ahead of anchored threads in the sidebar. Asserted against the
    // rendered order rather than the array, since the array is the page's and
    // the ordering is the component's.
    // Scoped: the readonly editor on this page has a sidebar toggle too, and an
    // unscoped role query matches both.
    const host = page.locator('[data-testid="editor-host"]');
    await host.getByRole('button', { name: /comments sidebar/ }).click();
    const renderedRows = page.locator('#imperative-editor-sidebar button.thread-item');
    await expect(renderedRows).toHaveCount(2);
    // The document thread is first, and it is the one the component marks as
    // document-level — asserting both rules out a coincidental ordering that
    // happened to put the right row on top.
    await expect(renderedRows.first()).toHaveAttribute('data-document', 'true');
    await expect(renderedRows.nth(1)).not.toHaveAttribute('data-document', 'true');
  });

  test('createDocumentThread is not orphaned by a re-anchoring pass', async ({ page }) => {
    await page.getByTestId('create-document-thread').click();
    await expect(threadCount(page)).toHaveText('threads: 1');

    // Removing text triggers re-anchoring. A document thread has no quote to
    // lose, so it must come through untouched rather than being swept up.
    // Poll for the ANCHORED thread to orphan first. That is the observable proof
    // a re-anchoring pass actually ran; polling `.not.toBe('orphaned')` on the
    // document thread matched on the first sample and would have passed against
    // a component that never re-anchors at all.
    await selectQuote(page);
    await page.getByTestId('create-thread-nodomselect').click();
    await expect(threadCount(page)).toHaveText('threads: 2');

    await page.getByTestId('remove-quote').click();
    await expect
      .poll(async () => {
        const rows = await anchors(page);
        return rows.some((row) => row.status === 'orphaned');
      })
      .toBe(true);

    // The re-anchoring pass has now demonstrably run. The document thread came
    // through it untouched.
    const documentRows = await anchors(page);
    const documentRow = documentRows.find((row) => row.type === 'document');
    expect(documentRow).toBeDefined();
    expect(documentRow!.status).not.toBe('orphaned');
  });

  test('createBlockThread anchors a whole block with no text selection, and survives an edit elsewhere', async ({
    page,
  }) => {
    // No drag: the caret is collapsed into paragraph three, which is the
    // affordance separating this from createThread.
    await page.getByTestId('create-block-thread').click();
    await expect(threadCount(page)).toHaveText('threads: 1');

    const row = await firstAnchor(page);
    expect(row.quote).toBe(PARAGRAPH_THREE);
    // Worth stating precisely, because the obvious phrasing overreaches. A
    // block thread is not given a distinct anchor TYPE — but the component
    // does not type a plain text anchor either: it leaves `type` undefined for
    // both, and the `'text'` here is this page's own `?? 'text'`
    // normalisation, matching what the d.ts calls the backwards-compatible
    // reading. So "nothing distinguishes a block thread" would be false.
    expect(row.type).toBe('text');
    expect(row.rawType).toBeNull();
    // `blockId` is what actually distinguishes it, and it is set only here —
    // see the coordinate-space test, where a text anchor reports null.
    expect(row.blockId).toEqual(expect.any(String));
    expect(row.blockId).not.toBe('');
    const before = { from: row.from, to: row.to };

    // Edit paragraph three's neighbours, not the block itself.
    // Insert BEFORE the block, not into it. `edit-elsewhere` appends to paragraph
    // three, which is the very block this thread anchors — so asserting the
    // anchor was unmoved by it could never fail, and two independent drift
    // injections left it green. Inserting ahead of the block means correct
    // mapping MUST move the anchor by exactly the inserted length.
    const lengthBefore = await page.getByTestId('value-length').textContent();
    await page.getByTestId('insert-before-block').click();
    await expect(page.getByTestId('value-length')).not.toHaveText(lengthBefore ?? '');

    // All four assertions below are PINS, proven red by independent breaks:
    // `quote: newQuote.slice(1)` in the re-anchoring write-back reddens the quote
    // line, `status: 'orphaned'` reddens the status line, and `from/to + 3` at
    // `review-editor-impl.svelte:484-485` reddens both position lines.
    //
    // An earlier version of this comment called the position lines an "accepted
    // guard" that could not be falsified, on the strength of three injections
    // that "left it green". That was wrong, and both reasons are worth recording
    // because either will silently fake a negative result again:
    //
    // 1. There are TWO `handleAnchorsUpdate` implementations. The one in
    //    `review-editor-anchors.svelte.js` is exported but never imported by the
    //    rendered component — dead code. Breaking it proves nothing. The live one
    //    is `review-editor-impl.svelte:471`.
    // 2. `vite dev` serves this package from `node_modules/.vite/deps`, a
    //    pre-bundled cache invalidated by lockfile changes and NOT by edits to a
    //    dependency's own files. A warm cache silently runs the OLD code, so a
    //    break-and-restore reports "no effect" while never having been loaded.
    //    `rm -rf node_modules/.vite` first, or drive `build && preview`, which is
    //    immune and is what this suite uses.
    //
    // Only the `anchor-decorations.js:274-275` mapping injection genuinely stays
    // green, and for a real reason: quote-based re-anchoring absorbs mapping
    // drift before it reaches `threads`.
    const shift = 'Prefixed. '.length;
    await expect
      .poll(async () => {
        const movedAnchor = await firstAnchor(page, 'moved anchor');
        return movedAnchor.from;
      })
      .toBe(before.from! + shift);
    const after = await firstAnchor(page, 'anchor after edit');
    expect(after.quote).toBe(PARAGRAPH_THREE);
    expect(after.to).toBe(before.to! + shift);
    expect(after.status).toBe('anchored');
  });

  test('createBlockThread refused at document start names both remaining bail branches honestly', async ({
    page,
  }) => {
    // KNOWN BUG, pinned as-is until here: createBlockThread's guard has THREE
    // bail branches (readonly, view unavailable, caret outside any block).
    // Readonly is structurally impossible on this instance, but the earlier
    // reason string named only the view branch — and this branch, "caret
    // outside any block", is reachable with the view fully mounted. Document
    // position 0 resolves to depth 0, outside every block node.
    const announcement = page.getByTestId('announcement');
    await page.getByTestId('create-block-thread-at-doc-start').click();

    await expect(lastReturn(page)).toHaveText('last return: null');
    await expect(threadCount(page)).toHaveText('threads: 0');
    await expect(announcement).toHaveText(
      /was refused: the editor view is not ready, or the caret is not inside a block/,
    );
    await expect(announcement).not.toHaveText(/the editor is readonly/);
  });
});
