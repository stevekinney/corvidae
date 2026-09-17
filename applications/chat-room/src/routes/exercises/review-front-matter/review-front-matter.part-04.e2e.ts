import { expect, test } from '@playwright/test';
import type { Page } from './review-front-matter-test-helpers';
import { applyPatchInTempRepo, openFixture } from './review-front-matter-test-helpers';

function renderedString(value: string | null): string {
  expect(value).not.toBeNull();
  const parsed: unknown = JSON.parse(value ?? 'null');
  if (typeof parsed !== 'string') throw new Error('Expected rendered value to be a string.');
  return parsed;
}

function hunkCounts(diff: string): Array<{ declared: [number, number]; actual: [number, number] }> {
  const hunks: Array<{ declared: [number, number]; actual: [number, number] }> = [];
  for (const line of diff.split('\n')) {
    const header = /^@@ -\d+,(\d+) \+\d+,(\d+) @@/.exec(line);
    if (header) {
      hunks.push({ declared: [Number(header[1]), Number(header[2])], actual: [0, 0] });
      continue;
    }
    const hunk = hunks.at(-1);
    if (!hunk || line.startsWith('--- ') || line.startsWith('+++ ') || line === '') continue;
    if (line.startsWith('-')) hunk.actual[0] += 1;
    else if (line.startsWith('+')) hunk.actual[1] += 1;
    else if (line.startsWith(' ')) {
      hunk.actual[0] += 1;
      hunk.actual[1] += 1;
    }
  }
  return hunks;
}

test.describe('review front matter: unified diff', () => {
  let page: Page;

  // The signature of the OLD bug: a line made entirely of dashes, carrying a
  // diff marker. Markdown's setext-heading underline. It appears in NEITHER
  // input document, so any diff line matching this was invented by
  // normalization. Kept as a regression tripwire now that the bug is fixed.
  const INVENTED_UNDERLINE = /^[-+]-{8,}$/m;

  // The whole patch the fixture's one-key change should produce, byte for byte.
  // Both `---` fences survive as unchanged context lines, the YAML keeps its
  // authored spelling, and only `draft:` moves.
  const EXPECTED_DIFF = [
    '--- a/document.md',
    '+++ b/document.md',
    '@@ -1,6 +1,6 @@',
    ' ---',
    '+draft: false',
    ' title: Release Plan',
    '-draft: true',
    ' ---',
    ' ',
    ' # Release Plan',
    '',
  ].join('\n');

  // What `git apply` actually validates, and what the old bug broke: a hunk
  // header's declared line counts have to match the lines that follow it.
  // Corrupted output still *looked* like a diff — it claimed `-1,8 +1,8` over
  // invented content — so a header-only assertion would not have caught it.

  test.beforeAll(async ({ browser }) => {
    page = await openFixture(browser);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('the default normalization keeps the front-matter block verbatim and normalizes only the body', async () => {
    // This used to be the route's headline bug. `generateUnifiedDiff` defaults
    // to `normalizeInputs: true`, and it used to hand the WHOLE document to the
    // markdown pipeline's `normalize()`. That pipeline has no front-matter
    // step, so the opening `---` was re-read as a thematic break and the YAML
    // lines as a paragraph closed by the second `---` — i.e. a setext heading,
    // whose underline was re-emitted as a run of dashes as long as the longest
    // line it underlined. The result: 8-dash lines present in neither document,
    // a blank line injected after the opening fence, lost sequence indentation,
    // and hunk headers (`@@ -1,8 +1,8 @@`) describing a document that never
    // existed — a patch `git apply` rejects, from an API whose docs promise
    // git-appliable output.
    //
    // Fixed upstream in `@repo/editor` (the "fix front-matter diffs"
    // change; no issue number was filed for it) by doing what `DiffViewer`
    // already did: parse the front matter off, normalize only the BODY, and
    // re-attach the front matter verbatim. So the fences and the YAML now pass
    // through untouched and only the body is canonicalized.
    const rendered = await page.getByTestId('fm-diff-default').getAttribute('data-value');
    const diff = renderedString(rendered);

    // Nothing was invented, and no blank line was pushed in after the fence.
    expect(diff).not.toMatch(INVENTED_UNDERLINE);
    expect(diff).not.toContain('@@ -1,8 +1,8 @@');
    // Both delimiters survive as three-dash context lines, in place, with the
    // only real change between them.
    expect(diff).toContain('\n ---\n+draft: false\n title: Release Plan\n-draft: true\n ---\n');
    // And the hunk header describes the documents that actually exist.
    expect(hunkCounts(diff)).toEqual([{ declared: [6, 6], actual: [6, 6] }]);
    // Byte-for-byte, since the point is that nothing is rewritten.
    expect(diff).toBe(EXPECTED_DIFF);
  });

  test('the invented dash line exists in neither input document', async () => {
    // Cross-checked against the documents the component itself is holding,
    // not against a literal: the hidden form inputs carry the exact original
    // and current markdown that fed the diff.
    const original = await page.locator('input[name="fm-diff-original"]').getAttribute('value');
    const current = await page.locator('input[name="fm-diff-current"]').getAttribute('value');
    expect(original).not.toBeNull();
    expect(current).not.toBeNull();
    expect(original!).not.toMatch(/^-{8,}$/m);
    expect(current!).not.toMatch(/^-{8,}$/m);
    // Both documents really do contain the front matter under test.
    expect(original!).toContain('draft: true');
    expect(current!).toContain('draft: false');
  });

  test('`normalizeInputs: false` produces the same six-line diff the default now does', async () => {
    const rendered = await page.getByTestId('fm-diff-raw').getAttribute('data-value');
    const diff = renderedString(rendered);
    expect(diff).not.toMatch(INVENTED_UNDERLINE);
    // The true shape of the change: one line removed, one added, delimiters
    // and body as context — and hunk counts that match the real documents.
    expect(diff).toContain('@@ -1,6 +1,6 @@');
    expect(diff).toContain('\n+draft: false\n');
    expect(diff).toContain('\n-draft: true\n');
    // This opt-out used to be the ONLY way to get that patch; it was the
    // control that proved the damage above came from normalization rather than
    // from the line differ. Now that normalization leaves front matter alone,
    // the two agree byte for byte on this fixture — which is itself the
    // clearest statement of the fix, and would break again the moment
    // `normalize()` got its hands on the block.
    expect(diff).toBe(EXPECTED_DIFF);
  });

  test('the `<name>-diff` hidden input ships an appliable diff', async () => {
    // `exportUnifiedDiff()` calls `generateUnifiedDiff(getState())` with no
    // options, so this hidden form input — the thing a surrounding form would
    // actually POST, and what `getFormData().diff` returns — inherits whatever
    // the default does. That used to make it the widest blast radius of the
    // front-matter corruption above: every consumer who submitted the form,
    // or hit the Copy Diff menu item, shipped a patch with invented dash lines
    // and hunk headers (`@@ -1,8 +1,8 @@`) that `git apply` refuses. There was
    // no opt-out here, because the export path passes no options.
    //
    // Now that normalization parses the front matter off and re-attaches it
    // verbatim, the export path inherits the correct patch for free.
    const hidden = page.locator('input[name="fm-diff-diff"]');
    await expect(hidden).toHaveCount(1);
    const value = await hidden.getAttribute('value');
    expect(value).not.toBeNull();
    expect(value!).not.toMatch(INVENTED_UNDERLINE);
    expect(value!).not.toContain('@@ -1,8 +1,8 @@');
    // The fences reach the form untouched.
    expect(value!).toContain('\n ---\n+draft: false\n title: Release Plan\n-draft: true\n ---\n');

    // ROADMAP RE-2 replaced this test's load-bearing assertion. It used to end
    // at `hunkCounts(value!)` — a hand-rolled check that a hunk header's
    // declared counts match the lines under it. That check is real but weak:
    // it is a restatement of the arithmetic the generator already did, and it
    // cannot see a wrong start line, a context line that does not match the
    // file, or a missing trailing newline. Calling a patch "appliable" on that
    // basis is the same move that let the front-matter corruption through
    // review in the first place, so the claim is now settled by git itself.
    // (`hunkCounts` survives above, where it documents the OLD bug's
    // signature — `@@ -1,8 +1,8 @@` over a document that never existed —
    // rather than standing in for appliability.)
    //
    // The document written to disk is read back out of the component's own
    // `fm-diff-original` input rather than retyped here, so a fixture edit
    // cannot leave the patch and the file describing different documents.
    const original = await page.locator('input[name="fm-diff-original"]').getAttribute('value');
    const current = await page.locator('input[name="fm-diff-current"]').getAttribute('value');
    expect(original).not.toBeNull();
    expect(current).not.toBeNull();
    // Applying for real and comparing the bytes, not just `--check`: git
    // searches for a hunk's context instead of trusting its `@@` start line,
    // so `--check` alone would accept a header pointing at the wrong line.
    // The trailing newline is the helper's, and it is there because
    // `normalizeInputs: true` makes the patch describe both sides as
    // newline-terminated while the fixture string is not.
    expect(current!.endsWith('\n')).toBe(false);
    expect(applyPatchInTempRepo(original!, value!)).toBe(`${current!}\n`);

    // The control that keeps the assertion above honest: the same patch with
    // one hunk-header count bumped by one — the exact shape of the corruption
    // this route was built around — is refused.
    expect(() =>
      applyPatchInTempRepo(original!, value!.replace('@@ -1,6 +1,6 @@', '@@ -1,7 +1,6 @@')),
    ).toThrow(/corrupt patch/);

    // Still byte-identical to the standalone default-options call rendered on
    // the page — which is what attributes the behavior to
    // `generateUnifiedDiff`'s default rather than to anything the editor did.
    const rendered = await page.getByTestId('fm-diff-default').getAttribute('data-value');
    expect(JSON.parse(rendered!)).toBe(value);
    // And identical to the `normalizeInputs: false` output too: the export
    // path no longer has a hidden penalty for not being able to pass options.
    const raw = await page.getByTestId('fm-diff-raw').getAttribute('data-value');
    expect(JSON.parse(raw!)).toBe(value);
  });
});

// ROADMAP RE-2, the WITH-front-matter half of "the same check runs for a document
// with YAML front matter and one without". `review-form-and-exports` owns the
// without half and the same `applyPatchInTempRepo` helper serves both.
//
// This route is where appliability matters most. Every other export surface on
// it survived the front-matter corruption unchanged; the diff was the one that
// shipped a patch `git apply` refuses, from an API documented as producing git
// patches. Asserting that here with git rather than with arithmetic is the whole
// point of the item.
