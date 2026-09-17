import { expect, test } from '@playwright/test';
import type { Page } from './review-form-and-exports-test-helpers';
import {
  EXPECTED_DIFF,
  applyPatchInTempRepo,
  copyFromExportMenu,
  gotoReady,
  namedEditor,
  submitAndRead,
  valueOf,
} from './review-form-and-exports-test-helpers';

function bulletsIn(document: string, marker: string): number {
  return document.split('\n').filter((line) => line.startsWith(marker)).length;
}

// ROADMAP RE-2. Everything above asserts that the diff LOOKS right — byte-exact
// literals, hunk headers, `+`/`-` line counts. That is exactly the standard the
// front-matter corruption cleared before it was fixed: correct `---`/`+++`
// headers over content that existed in neither document. The only assertion that
// actually settles "is this a patch?" is git's, so these tests hand the string
// to `git apply` in a throwaway repo.
//
// This is the no-front-matter half of the criterion; `review-front-matter` owns
// the other half against a YAML document, and both import the same helper.
test.describe('the exported diff is a patch git will apply', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    // An explicit permissioned context, for the same reason the export-menu
    // describe needs one: `test.use({ permissions })` configures the `page`
    // FIXTURE, and a describe-shared page from `browser.newPage()` would not
    // inherit it, so the clipboard read below would fail on permission.
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    page = await context.newPage();
    await gotoReady(page);
  });
  test.afterAll(async () => {
    await page.context().close();
  });
  test('all three export surfaces ship one string, and git applies it to the original', async () => {
    // The three surfaces RE-2 names, read in the order a consumer would meet
    // them: the hidden input a form POSTs, the imperative `getFormData()`, and
    // the export menu. All three read the same `$derived` in
    // `review-editor-impl.svelte`, which is a claim about the implementation —
    // this is where it becomes an observation.
    //
    // The criterion calls the menu item "Copy Diff". There is no such label:
    // it is "Git Diff", behind a trigger whose accessible name is "Copy to
    // clipboard". Correcting the wording rather than inventing a selector.
    const hidden = await page.locator('#exports-form input[name="review-diff"]').inputValue();
    await page.getByTestId('read-form-data').click();
    await expect(page.getByTestId('imperative-form-data')).not.toHaveValue('');
    const parsedFormData: unknown = JSON.parse(
      await valueOf(page.getByTestId('imperative-form-data')),
    );
    if (
      typeof parsedFormData !== 'object' ||
      parsedFormData === null ||
      Array.isArray(parsedFormData)
    ) {
      throw new Error('Expected imperative form data to be an object.');
    }
    const imperative = Reflect.get(parsedFormData, 'diff');
    if (typeof imperative !== 'string') throw new Error('Expected imperative diff to be a string.');
    const copied = await copyFromExportMenu(page, /^Git Diff/, 'Copied Git Diff');
    expect(hidden).toBe(EXPECTED_DIFF);
    expect(imperative).toBe(EXPECTED_DIFF);
    expect(copied).toBe(EXPECTED_DIFF);
    // The document written to disk is the one the COMPONENT is holding, read
    // back out of its own hidden input rather than retyped from the fixture —
    // so an edit to `+page.svelte` cannot leave the patch and the file it is
    // applied to describing different documents.
    const original = await page.locator('#exports-form input[name="review-original"]').inputValue();
    const current = await page.locator('#exports-form input[name="review-current"]').inputValue();
    // Stated rather than assumed, because the next assertion adds a byte the
    // component never emitted: at rest the current document has no trailing
    // newline, and `applyPatchInTempRepo` writes the seed file with one
    // because `normalizeInputs: true` makes the patch describe both sides as
    // newline-terminated.
    expect(current.endsWith('\n')).toBe(false);
    // `--check` runs inside the helper; this compares the APPLIED BYTES, which
    // is strictly stronger. Measured while building this: `git apply` searches
    // for a hunk's context instead of trusting its start line, so a patch with
    // a wrong `@@` start still passes `--check`. Only the result catches it.
    expect(applyPatchInTempRepo(original, hidden)).toBe(`${current}\n`);
  });
  test('the appliability check is itself capable of failing', async () => {
    // A control for the harness, not for the component. An appliability
    // assertion is worth nothing unless a bad patch actually reddens it, and
    // two of these three are the exact failure shapes RE-2 was written about.
    const original = await page.locator('#exports-form input[name="review-original"]').inputValue();
    // One: a hunk header that lies about its own line counts. This is the
    // front-matter corruption's signature — a patch that looks entirely
    // well-formed to a reader and to `hunkCounts()`-style structural checks.
    expect(() =>
      applyPatchInTempRepo(original, EXPECTED_DIFF.replace('@@ -1,8 +1,9 @@', '@@ -1,9 +1,9 @@')),
    ).toThrow(/corrupt patch/);
    // Two: an edited context line, i.e. a patch describing a document that is
    // not the one on disk.
    expect(() =>
      applyPatchInTempRepo(original, EXPECTED_DIFF.replace(' ## Checklist', ' ## CHECKLIST')),
    ).toThrow(/patch failed/);
    // Three: the empty string, which is what `generateUnifiedDiff` returns for
    // two documents that normalize identically. `git apply` answers "No valid
    // patches in input"; the helper refuses first, so the fixture error reads
    // as a fixture error.
    expect(() => applyPatchInTempRepo(original, '')).toThrow(/empty patch/);
    // UNFALSIFIABLE BY COMPONENT CODE, and kept deliberately: this pins GIT's
    // behavior, not the editor's. A hunk header claiming line 4 for a hunk
    // that starts at line 1 is ACCEPTED, and produces the identical result,
    // because git searches for the context. It is the measurement that
    // justifies comparing applied bytes above instead of trusting `--check`,
    // and without it a reader would reasonably assume `--check` pins the
    // header.
    const shifted = EXPECTED_DIFF.replace('@@ -1,8 +1,9 @@', '@@ -4,8 +4,9 @@');
    expect(applyPatchInTempRepo(original, shifted)).toBe(
      applyPatchInTempRepo(original, EXPECTED_DIFF),
    );
  });
  test('a patch produced AFTER a real edit still applies — to the canonical document, not the editor bytes', async ({
    page: ownPage,
  }) => {
    // Its own page: this types into the shared fixture.
    //
    // The at-rest test above proves the export is appliable for a document
    // nobody has touched. That is the easy case: both sides are already
    // canonical Markdown, so normalization is the identity. The moment anyone
    // types, Milkdown re-serializes the WHOLE document — `-` bullets become
    // `*`, a trailing newline appears — and the question becomes whether the
    // patch still describes the file a consumer has on disk. It does, and the
    // mechanism is the normalization the diff applies to both sides.
    await gotoReady(ownPage);
    const paragraph = namedEditor(ownPage)
      .getByRole('textbox', { name: 'Markdown editor' })
      .locator('p')
      .first();
    await paragraph.click();
    await ownPage.keyboard.press('End');
    await ownPage.keyboard.type(' ZZTOP');
    await expect(ownPage.getByTestId('live-value')).toHaveValue(/ZZTOP/);
    await submitAndRead(ownPage, 'submit-named', 'named-submit-count');
    const original = await valueOf(ownPage.getByTestId('submitted-original'));
    const current = await valueOf(ownPage.getByTestId('submitted-current'));
    const diff = await valueOf(ownPage.getByTestId('submitted-diff'));
    const applied = applyPatchInTempRepo(original, diff);
    expect(applied).toContain('inline review. ZZTOP');
    // And the part worth knowing before you ship this patch anywhere: applying
    // it does NOT reproduce the document the editor is holding. The editor's
    // `value` has `*` bullets; the patch normalizes them back to `-`, so the
    // file on disk afterwards is the CANONICAL form of the review, not the
    // component's serialization of it. Neither is wrong, but a consumer
    // round-tripping value → patch → disk → value will see their bullets flip.
    expect(applied).not.toBe(current);
    // Stated as a census rather than as one example, so "the bullets flip" is
    // a measurement instead of an impression: the editor's serialization has
    // three `*` list items and the applied file has none.
    expect(bulletsIn(current, '* ')).toBe(3);
    expect(bulletsIn(current, '- ')).toBe(0);
    expect(bulletsIn(applied, '* ')).toBe(0);
    expect(bulletsIn(applied, '- ')).toBe(3);
  });
});
