import { expect, test } from '@playwright/test';
import type { Page } from './review-form-and-exports-test-helpers';
import {
  EXPECTED_ORPHAN_SUMMARY_AT_REST,
  applyPatchInTempRepo,
  gotoReady,
  orphanField,
  valueOf,
} from './review-form-and-exports-test-helpers';

// ROADMAP RE-2, the summary half: orphaned threads must be labelled as no longer
// in the document, and the export must not print a coordinate it does not have.
test.describe('exportMarkdownSummary and the three thread heading shapes', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await gotoReady(page);
  });
  test.afterAll(async () => {
    await page.close();
  });
  test('at rest all three threads are anchored and the summary is a Feedback section with no digit in it', async () => {
    // Asserted first so the post-deletion test below is a real TRANSITION
    // rather than a reading of a state that was seeded that way. Nothing on
    // this page seeds `status: 'orphaned'`.
    await expect(page.getByTestId('orphan-thread-statuses')).toHaveText(
      'thread-heading:anchored,thread-rollout:anchored,thread-whole-document:anchored',
    );
    await expect(page.getByTestId('orphan-thread-count')).toHaveText('threads: 3');
    const summary = await orphanField(page, 'summary').inputValue();
    expect(summary).toBe(EXPECTED_ORPHAN_SUMMARY_AT_REST);
    // The component's own export and the module function fed the same live
    // props, byte identical.
    expect(summary).toBe(await valueOf(page.getByTestId('orphan-module-summary')));
    // "Never prints a coordinate it does not have", at its strongest: with
    // `original === value` there is no `## Changes Made` section, and the
    // Feedback section that remains contains no digit at all. No anchor
    // position, no text offset, no line number — just quotes and bodies.
    expect(summary).not.toMatch(/\d/);
    expect(summary).not.toContain('## Changes Made');
    // `threadCount` counts every visible thread including the document-level
    // one, which is what makes "3" here rather than "2".
    await expect(page.getByTestId('orphan-module-stats')).toHaveText('changeCount:0 threadCount:3');
  });
  test('an unedited document exports the empty string, which is not a patch', async () => {
    // The fixture's `original` equals its `value`, so `generateUnifiedDiff`
    // short-circuits to `''` — not to a zero-hunk patch. Worth pinning as
    // component behavior AND as the justification for the helper's guard:
    // `git apply` answers "No valid patches in input" for empty stdin, which
    // would read as an appliability failure rather than as "there was nothing
    // to apply".
    const diff = await orphanField(page, 'diff').inputValue();
    expect(diff).toBe('');
    const original = await orphanField(page, 'original').inputValue();
    expect(() => applyPatchInTempRepo(original, diff)).toThrow(/empty patch/);
  });
  test('deleting the anchored text relabels that thread and leaves the other two alone', async ({
    page: ownPage,
  }) => {
    // Its own page: this edits the document.
    //
    // The orphan is PRODUCED rather than seeded. Deleting the exact
    // ProseMirror range the anchor covers is the path a reviewer takes when
    // they act on a comment, and it is the only way to prove `anchor.status`
    // survives the component's own persistence round-trip
    // (`getState()` → `toPersistedThreads`) into the export. A hand-written
    // `status: 'orphaned'` in the fixture would prove only that the export
    // function reads the field.
    await gotoReady(ownPage);
    await ownPage.getByTestId('orphan-delete').click();
    // The re-anchoring pass is debounced ~300ms and writes the new status back
    // into the bindable array. Waiting on THAT — an auto-retrying read of a
    // value the page already renders — rather than on a sleep sized to the
    // debounce.
    await expect(ownPage.getByTestId('orphan-thread-statuses')).toHaveText(
      'thread-heading:anchored,thread-rollout:orphaned,thread-whole-document:anchored',
    );
    // Orphaning is not deletion: the thread stays in the array and the comment
    // survives.
    await expect(ownPage.getByTestId('orphan-thread-count')).toHaveText('threads: 3');
    // And wait for the EDITED TEXT to reach the page as well, which is a
    // separate settle from the one above and arrives later.
    //
    // The summary `$derived` reads both `orphanThreads` and `orphanValue`. The
    // statuses settle on the re-anchoring pass; `orphanValue` settles on the
    // editor's own change propagation, which is two stacked TRAILING debounces
    // — Milkdown's listener plugin at 200ms, then the editor wrapper's
    // `onchange` at a further 300ms. So the statuses can read `orphaned` while
    // `content` is still the original text, and a summary read in that window
    // legitimately has no `## Changes Made` section: there is nothing to diff
    // yet.
    //
    // That is exactly how this test failed — asserting `## Changes Made`
    // against a state whose content had not moved. Verified by feeding the
    // post-delete document to `generateMarkdownSummary` directly, which emits
    // the section and `### Lines 1-5`, so the export is not at fault.
    //
    // Waiting on the rendered value, not on a duration: the readout is the
    // condition, and a slower machine takes longer rather than passing wrongly.
    await expect(ownPage.getByTestId('orphan-live-value')).not.toHaveValue(
      /The beta rollout ships/,
    );
    // The hidden input is a `$derived` of the same threads array, so it has
    // already settled by the time the status line above reads `orphaned`.
    // Polled anyway rather than read once: the two are updated by the same
    // flush, and depending on that ordering is the kind of assumption that
    // only fails under load.
    await expect
      .poll(() => orphanField(ownPage, 'summary').inputValue())
      .toContain('(no longer in the document)');
    const summary = await orphanField(ownPage, 'summary').inputValue();
    // The three heading shapes, side by side in one export. Only the first
    // carries the parenthetical, and it is the only anchor whose quote is gone.
    expect(summary).toContain('### On "beta rollout" (no longer in the document)');
    expect(summary).toContain('### On "Beta Notes"');
    expect(summary).not.toContain('### On "Beta Notes" (no longer in the document)');
    expect(summary).toContain('### Document-level feedback');
    // The document-level thread is NOT labelled as orphaned, which is the
    // confusion this trio exists to rule out: "no quote" and "quote is gone"
    // are different states with different headings.
    expect(summary).not.toContain('### Document-level feedback (no longer in the document)');
    // Every comment survives the orphaning.
    expect(summary).toContain('> Which teams, exactly?');
    expect(summary).toContain('> Heading reads fine.');
    expect(summary).toContain('> Overall: ready to ship.');
    // Component and module still agree after a real edit.
    expect(summary).toBe(await valueOf(ownPage.getByTestId('orphan-module-summary')));
    // The coordinate assertion, now scoped: the deletion gave the document a
    // `## Changes Made` section, and THAT section legitimately prints
    // `### Lines a-b` computed from the line diff. The Feedback section still
    // prints no number of any kind — least of all the stale offset the
    // orphaned anchor is still carrying internally.
    expect(summary).toContain('## Changes Made');
    expect(summary).toMatch(/### Lines \d+-\d+/);
    const feedback = summary.slice(summary.indexOf('## Feedback'));
    expect(feedback).not.toMatch(/\d/);
    expect(feedback).not.toMatch(/offset|position|column/i);
  });
});
