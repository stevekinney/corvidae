import { expect, test } from '@playwright/test';
import {
  CONTENT_HEADING,
  CONTENT_ORIGINAL_HEADING,
  CONTENT_REPLACEMENT,
  REMOVED_QUOTE,
  ROUTE,
  SURVIVING_QUOTE,
  contentAnchors,
  contentEvents,
  contentMarkdown,
  gotoHydrated,
  probeUndoDepth,
  readAst,
  renderedBlocks,
  seedContent,
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
test.describe('review-imperative: content replacement and reset (RE-3)', () => {
  test('setMarkdown re-anchors the quote that survives, orphans the one that does not, and drops neither', async ({
    page,
  }) => {
    const seeded = await seedContent(page);
    const survivor = seeded.find((row) => row.quote === SURVIVING_QUOTE)!;
    const doomed = seeded.find((row) => row.quote === REMOVED_QUOTE)!;
    expect(survivor).toBeDefined();
    expect(doomed).toBeDefined();

    // EXACT, from the page's hand derivation: 'dashboard owner' sits at index 25
    // of a paragraph whose ProseMirror content starts at 30 and whose
    // textBetween run starts at 28, so 55/70 and 53 are three independent
    // arithmetic claims about one selection.
    expect(survivor.from).toBe(55);
    expect(survivor.to).toBe(70);
    expect(survivor.lastKnownOffset).toBe(53);
    expect(doomed.from).toBe(99);
    expect(doomed.to).toBe(117);
    expect(doomed.lastKnownOffset).toBe(96);
    expect([survivor.status, doomed.status]).toEqual(['anchored', 'anchored']);

    await page.getByTestId('content-set-markdown').click();

    // Polled past the plugin's 300ms re-anchor debounce rather than waited out.
    // That pass ALSO skips its run and reschedules if the document changed
    // during the window, so there is no duration it would be safe to sleep for.
    await expect
      .poll(async () => {
        const rows = await contentAnchors(page);
        return rows.find((row) => row.id === doomed.id)?.status;
      })
      .toBe('orphaned');

    const after = await contentAnchors(page);
    // NEITHER thread dropped — RE-3's third clause, and the one that a status
    // assertion alone would not cover.
    expect(after).toHaveLength(2);
    expect(after.map((row) => row.id).toSorted()).toEqual([survivor.id, doomed.id].toSorted());

    const survivorAfter = after.find((row) => row.id === survivor.id)!;
    // RE-ANCHORED, not merely left alone. `setMarkdown` reaches the editor as a
    // single step spanning the whole document, which `isFullDocumentReplacement`
    // (anchor-decorations.js) detects: position mapping is meaningless across
    // it, so every anchor is kept verbatim and handed to the deferred pass,
    // which searches by QUOTE. The replacement inserts a paragraph ahead of the
    // quote precisely so a correct search has to land somewhere new — without
    // that insertion, "re-anchored" and "never touched" produce the same
    // numbers.
    expect(survivorAfter.status).toBe('anchored');
    expect(survivorAfter.quote).toBe(SURVIVING_QUOTE);
    expect(survivorAfter.from).toBe(110);
    expect(survivorAfter.to).toBe(125);
    expect(survivorAfter.lastKnownOffset).toBe(107);

    const doomedAfter = after.find((row) => row.id === doomed.id)!;
    // ORPHANED with its quote KEPT, which is what lets the text coming back
    // restore the thread — and its comment kept with it.
    expect(doomedAfter.status).toBe('orphaned');
    expect(doomedAfter.quote).toBe(REMOVED_QUOTE);
    expect(doomedAfter.comments).toBe(1);

    // The rendered decoration follows the same split: an orphan renders
    // nothing, so exactly one anchor span survives, over the surviving quote.
    const decorations = page.locator('#imperative-content .ProseMirror span.comment-anchor');
    await expect(decorations).toHaveCount(1);
    expect(((await decorations.textContent()) ?? '').trim()).toBe(SURVIVING_QUOTE);
  });

  test('setMarkdown writes the value prop verbatim, and getMarkdown re-serialises the same document', async ({
    page,
  }) => {
    await page.getByTestId('content-set-markdown').click();
    await page.getByTestId('content-get-markdown').click();

    const report = await contentMarkdown(page);

    // `setMarkdown`'s first statement is `value = content`, and the editor's own
    // change listener is suppressed for the replaceAll it triggers
    // (`isExternalUpdate`, dist/editor/editor.js) — so nothing writes a
    // normalised form back over it and the prop holds the exact string.
    expect(report.valueProp).toBe(CONTENT_REPLACEMENT);

    // `getMarkdown` is a DIFFERENT derivation: it re-serialises the live
    // ProseMirror document through Milkdown rather than echoing the prop.
    // Compared after trimming because the serializer canonicalises trailing
    // newlines and the claim here is about content, not framing — the raw
    // lengths ride along in `content-markdown-json` so a larger divergence
    // stays visible rather than being absorbed by the trim.
    expect(report.fromGetMarkdown.trim()).toBe(CONTENT_REPLACEMENT.trim());
    expect(report.fromGetMarkdown).toContain(SURVIVING_QUOTE);
    expect(report.fromGetMarkdown).not.toContain(REMOVED_QUOTE);
  });

  test('getAst still matches the DOM after setMarkdown, and reset now reaches the live document too', async ({
    page,
  }) => {
    // The BASELINE matters as much as the setMarkdown mutation below. Without
    // it, a getAst that always answered with the document it was first given
    // would satisfy "the AST agrees with the DOM" only until something
    // changed — and this test is the one asking whether it tracks a change at
    // all.
    expect(await readAst(page)).toEqual(await renderedBlocks(page));

    await page.getByTestId('content-set-markdown').click();
    await expect(page.locator('#imperative-content .ProseMirror > :is(h3,p)')).toHaveCount(4);

    const afterSet = await readAst(page);
    expect(afterSet).toEqual(await renderedBlocks(page));
    // Named explicitly, because "the two agree" is satisfiable by both being
    // empty and this fixture has a shape worth stating.
    expect(afterSet.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    expect(afterSet[0]).toEqual({ type: 'heading', depth: 3, text: CONTENT_HEADING });

    // FIXED, as of `@repo/editor@0.12.0`. This was a regression
    // introduced in 0.11.0 (absent in 0.10.0 — confirmed at the time by
    // deleting the one responsible line from the installed dist and watching
    // this go green, then restoring it and watching it go red again). Filed
    // as stevekinney/cinder#1328
    // (https://github.com/stevekinney/cinder/issues/1328), fixed by guarding
    // `MarkdownEditor.setMarkdown()`'s own `value` write with a read-compare
    // (`if (value !== content) value = content;`) instead of writing it
    // unconditionally.
    //
    // Mechanism, restated now that it is fixed rather than live: that
    // unconditional `value = content;` statement, added in 0.11.0 right
    // after `editorState.setMarkdown(content)`, ran even when `value`
    // already equalled `content` — which is exactly what happens one
    // statement into `ReviewEditor.reset()`'s own `value = original` having
    // already pushed a new value down. The write-compare-write from
    // `setMarkdown` used to fire regardless and re-stamp `value`, which
    // broke `MarkdownEditor`'s bindable "sync external value changes" effect
    // for that instance permanently: `ReviewEditor` passes
    // `value={editorValue}` down ONE-WAY, not via `bind:value`, so `reset()`
    // depends entirely on that effect noticing the prop moved. Guarding the
    // write means `setMarkdown` no longer touches `value` at all once it
    // already matches, so the effect stays connected and a later `reset()`
    // keeps working.
    //
    // Checked on the block count AND the heading, unlike the old pin (which
    // needed the inserted paragraph specifically, because `CONTENT_INITIAL`
    // and `CONTENT_REPLACEMENT` share a heading and a heading-only assertion
    // couldn't distinguish "reset landed `original`" from "reset did
    // nothing"). `original`'s heading ("Content Baseline") differs from both
    // of those, so post-fix the heading alone already discriminates; the
    // block count is kept alongside it as the second, independent signal.
    await page.getByTestId('content-reset').click();
    await expect(page.locator('#imperative-content .ProseMirror > :is(h3,p)')).toHaveCount(2);
    await expect(page.locator('#imperative-content .ProseMirror')).toContainText(
      'The rollout plan is still being drafted.',
    );
    await expect(page.locator('#imperative-content .ProseMirror')).not.toContainText(
      'A late addition pushes',
    );

    // getAst still agrees with the DOM, and now BOTH have actually moved to
    // `original` — the invariant this test's name promises, restored.
    const afterReset = await readAst(page);
    expect(afterReset).toEqual(await renderedBlocks(page));
    expect(afterReset).toEqual([
      { type: 'heading', depth: 3, text: CONTENT_ORIGINAL_HEADING },
      { type: 'paragraph', depth: null, text: 'The rollout plan is still being drafted.' },
    ]);
  });

  test('reset restores original rather than the initial value, clears the dirty state, and releases every thread', async ({
    page,
  }) => {
    const seeded = await seedContent(page);
    const ids = seeded.map((row) => row.id);

    // DIRTY beforehand, by the component's own reckoning rather than this
    // page's: the diff badge in its controls bar renders only when `diffStats`
    // is nonzero, and `diffStats` is derived from `original` against `value`.
    const dirtyBadge = page.locator('#imperative-content-controls .cinder-diff-statistics');
    await expect(dirtyBadge).toHaveCount(1);

    const eventsBefore = await contentEvents(page);
    await page.getByTestId('content-reset').click();

    // ROADMAP RE-3 says reset "returns the component to its initial `value`".
    // It does not — it is `value = original`. This instance mounts with
    // `original` set to a DIFFERENT document from its initial `value`, so
    // exactly one of those two claims can hold afterwards, and the rendered
    // heading says which.
    await expect(page.locator('#imperative-content .ProseMirror h3')).toHaveText(
      CONTENT_ORIGINAL_HEADING,
    );
    await expect(page.locator('#imperative-content .ProseMirror')).not.toContainText(
      SURVIVING_QUOTE,
    );

    // Threads are released by NOTIFICATION, one `onthreaddelete` per thread —
    // `reset` never touches the `threads` array itself. A consumer who does not
    // wire that callback keeps every thread through a reset, which is why the
    // events are asserted and not only the resulting count.
    const afterContentEvents = await contentEvents(page);
    const fired = afterContentEvents.slice(eventsBefore.length);
    expect(fired.toSorted()).toEqual(ids.map((id) => `onthreaddelete:${id}`).toSorted());
    await expect(page.getByTestId('content-thread-count')).toHaveText('content threads: 0');

    // CLEAN afterwards. There is no dirty flag for `reset` to clear: the state
    // is derived, so restoring the original clears it as a consequence.
    await expect(dirtyBadge).toHaveCount(0);
  });

  test('reset now dispatches a real transaction, and it reaches the live document even once setMarkdown has run on the same instance', async ({
    page,
  }) => {
    await page.getByTestId('content-set-markdown').click();
    // Waited on the INSERTED paragraph, not on the heading: the replacement
    // keeps the same heading text, so a heading assertion here would be
    // satisfied before `setMarkdown` had done anything at all.
    await expect(page.locator('#imperative-content .ProseMirror')).toContainText(
      'A late addition pushes',
    );
    let probeCount = 1;
    const beforeReset = await probeUndoDepth(page, probeCount);
    // Anchors that setMarkdown's own transaction is history-tracked, which
    // every undo claim below depends on.
    expect(beforeReset).toBeGreaterThan(0);

    // FIXED (stevekinney/cinder#1328) — same regression, and the same fix, as
    // the `getAst` test above; see that test's comment for the full
    // mechanism. `reset()` now reaches the live document even once
    // `setMarkdown` has been called on this instance: `MarkdownEditor`'s
    // bindable `value` keeps tracking `ReviewEditor`'s one-way
    // `value={editorValue}` push, because `setMarkdown`'s own write is now
    // guarded and no longer re-stamps `value` once it already matches.
    await page.getByTestId('content-reset').click();
    await expect(page.locator('#imperative-content .ProseMirror')).toContainText(
      'The rollout plan is still being drafted.',
    );
    await expect(page.locator('#imperative-content .ProseMirror')).not.toContainText(
      'A late addition pushes',
    );

    // The undo-depth NUMBER after reset is deliberately not asserted against
    // `beforeReset` here, in either direction. Measured directly (not
    // guessed): back-to-back clicks land reset's replaceAll inside
    // prosemirror-history's `newGroupDelay` window of setMarkdown's, so the
    // two get GROUPED into one history entry and the depth reads IDENTICAL
    // before and after (confirmed deterministic over 5 runs) — forcing a
    // >500ms gap between the two clicks (confirmed separately, not kept as
    // a test — this repo does not pad waits) instead produces a second,
    // ungrouped entry and the depth reads one higher. Both are "a
    // transaction fired"; only the DOM content above tells them apart from
    // "no transaction fired at all", which is what the pre-fix bug actually
    // did. What IS asserted, and is true either way, is that the depth
    // stays positive — the undo stack was not emptied or corrupted by the
    // reset.
    probeCount += 1;
    const afterReset = await probeUndoDepth(page, probeCount);
    expect(afterReset).toBeGreaterThan(0);

    // One undo, regardless of grouping, stays inside the pre-reset lineage:
    // grouped, it jumps past both transactions straight to the document
    // setMarkdown started from; ungrouped, it lands on setMarkdown's own
    // result. Either way that document still carries the REPLACEMENT
    // heading (shared with the pre-setMarkdown document) and never the
    // `original` heading — which is the deterministic, grouping-independent
    // way to show reset's change was itself undoable at all.
    await page.getByTestId('content-undo').click();
    await expect(page.locator('#imperative-content .ProseMirror')).toContainText(CONTENT_HEADING);
    await expect(page.locator('#imperative-content .ProseMirror')).not.toContainText(
      CONTENT_ORIGINAL_HEADING,
    );

    // Unwinding the rest of the stack — by POLLING the depth rather than
    // guessing how many clicks grouping needs — converges on the same place
    // either way: the document from before setMarkdown ever ran.
    probeCount += 1;
    let depth = await probeUndoDepth(page, probeCount);
    while (depth > 0) {
      await page.getByTestId('content-undo').click();
      probeCount += 1;
      depth = await probeUndoDepth(page, probeCount);
    }
    await expect(page.locator('#imperative-content .ProseMirror h3')).toHaveText(CONTENT_HEADING);
    await expect(page.locator('#imperative-content .ProseMirror')).toContainText(
      'The rollout plan names a dashboard owner and a migration owner.',
    );
    await expect(page.locator('#imperative-content .ProseMirror')).toContainText(
      'The rollback checklist is owned by the platform team.',
    );
    await expect(page.locator('#imperative-content .ProseMirror')).not.toContainText(
      'A late addition pushes',
    );
    await expect(page.locator('#imperative-content .ProseMirror')).not.toContainText(
      CONTENT_ORIGINAL_HEADING,
    );
  });

  test('reset is NOT guarded either, so a readonly editor is reset programmatically', async ({
    page,
  }) => {
    // The other half of RE-3's readonly criterion. `setMarkdown` was already
    // pinned as unguarded; `reset` carries no `mode === 'readonly'` check
    // either, and unlike `setMarkdown` it also destroys the review state.
    await expect(page.getByTestId('ro-thread-count')).toHaveText('readonly threads: 1');
    await expect(page.getByTestId('ro-value-length')).not.toHaveText('readonly value length: 0');

    await page.getByTestId('ro-reset').click();

    // This instance passes no `original`, and `original` defaults to `''`, so
    // `value = original` BLANKS it. That is the sharpest demonstration
    // available that reset restores the `original` PROP and not the value the
    // component started with — there is nowhere else the empty string could
    // have come from.
    await expect(page.getByTestId('ro-value-length')).toHaveText('readonly value length: 0');

    // The rendered document too, and that is a SEPARATE claim rather than a
    // restatement. `value = original` is a plain prop assignment that happens
    // before the component touches the editor at all, so the readout above
    // would report 0 even if the readonly ProseMirror view had refused the
    // replacement. Its heading is gone, so it did not.
    await expect(page.locator('#imperative-readonly .ProseMirror')).not.toContainText(
      'Readonly Reference',
    );

    // And the seeded thread is released through the same notification path, on
    // an editor a consumer was told is read-only.
    await expect(page.getByTestId('ro-events')).toHaveText('onthreaddelete:readonly-thread-1');
    await expect(page.getByTestId('ro-thread-count')).toHaveText('readonly threads: 0');
    await expect(page.getByTestId('announcement')).toHaveText(/reset\(readonly\) completed/);
  });
});
