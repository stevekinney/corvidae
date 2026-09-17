import { expect, test } from '@playwright/test';
import {
  FRONT_MATTER_UNCHANGED,
  HUNKS_ADDED_AND_REMOVED,
  HUNKS_ALL,
  HUNKS_TWO,
  ROUTE,
  bodyLines,
  changeCounter,
  changedFrontMatterText,
  expectHunks,
  gotoHydrated,
  modeRadio,
  unchangedFrontMatterText,
  viewer,
} from './diff-viewer-test-helpers';

test.beforeEach(async ({ page }) => {
  await gotoHydrated(page, ROUTE);

  // The body diff is produced by an `$effect`, which does not run during SSR:
  // the server sends the front-matter block and ZERO body rows, and the rows
  // appear only once hydration has flushed.
  //
  // NOT gated on `.diff-viewer[data-ready]`, which looks like the intended
  // signal — the component's own comment calls it "E2E test synchronization" —
  // and is not one on this tier. It renders when `!isComputing && !isStale`,
  // and both are false before the controller has run at all, so it is present
  // in the SSR HTML of a viewer that has computed nothing. It becomes a real
  // signal only at the manual tier, where `isStale` is set, and that is the one
  // place below that waits on it.
  await expect(bodyLines(page, 'a')).toHaveCount(15);
  await expect(bodyLines(page, 'b')).toHaveCount(5);
});
// ---------------------------------------------------------------------------
// DV-1 — the standalone mount, getHunks, front matter, and the view modes
// ---------------------------------------------------------------------------

test('getHunks matches bind:hunks and the rendered hunk headers on a known two-hunk document', async ({
  page,
}) => {
  await expectHunks(page, 'hunks-a', HUNKS_TWO);

  // `getHunks()` is a SEPARATE observation from `bind:hunks`, not a synonym for
  // it: the binding is written by an `$effect` copying out of the `computedHunks`
  // `$derived`, and `getHunks()` returns that copied field. Reading it through a
  // button click is what makes the two comparable at a defined moment.
  await page.getByTestId('read-hunks-a').click();
  await expectHunks(page, 'imperative-a', HUNKS_TWO);
  expect(await page.getByTestId('imperative-a').textContent()).toBe(
    await page.getByTestId('hunks-a').textContent(),
  );

  // The rendered headers are an INDEPENDENT path to the same hunks — they come
  // from `hunkStartMap`, which reads the `$derived` directly rather than the
  // effect-synced copy. Agreement between the two is the cross-check; comparing
  // `getHunks()` only against `bind:hunks` would compare one field with itself.
  const headers = viewer(page, 'a').locator('.hunk-header .hunk-range');
  await expect(headers).toHaveCount(2);
  await expect(headers.nth(0)).toHaveText('@@ -1,6 +1,6 @@');
  await expect(headers.nth(1)).toHaveText('@@ -12,4 +12,4 @@');

  await expect(changeCounter(page, 'a')).toHaveText('1 / 2');
});

test('an identical document yields an empty hunk list, not one all-context hunk', async ({
  page,
}) => {
  await page.getByTestId('doc-a-identical').click();

  // Asserted as an EMPTY ARRAY rather than as "no hunk headers rendered". The
  // weaker form passes against a component that computed a hunk and failed to
  // render it, which is a different bug wearing the same clothes.
  await expectHunks(page, 'hunks-a', []);
  await page.getByTestId('read-hunks-a').click();
  await expectHunks(page, 'imperative-a', []);

  // The rows are still all there — fifteen of them — they are simply all
  // `same`. A viewer that had thrown the document away would also report zero
  // hunks, and this is what tells the two apart.
  await expect(bodyLines(page, 'a')).toHaveCount(15);
  await expect(
    viewer(page, 'a').locator(
      '.diff-content > .diff-line-added, .diff-content > .diff-line-removed, .diff-content > .diff-line-modified',
    ),
  ).toHaveCount(0);

  await expect(viewer(page, 'a').locator('.no-changes')).toHaveCount(1);
  await expect(changeCounter(page, 'a')).toHaveCount(0);
  await expect(viewer(page, 'a').locator('.hunk-header')).toHaveCount(0);
});

test('an entirely rewritten body collapses into a single hunk spanning the document', async ({
  page,
}) => {
  await page.getByTestId('doc-a-all-changed').click();

  await expectHunks(page, 'hunks-a', HUNKS_ALL);
  await page.getByTestId('read-hunks-a').click();
  await expectHunks(page, 'imperative-a', HUNKS_ALL);

  const headers = viewer(page, 'a').locator('.hunk-header .hunk-range');
  await expect(headers).toHaveCount(1);
  await expect(headers).toHaveText('@@ -1,15 +1,15 @@');

  // Twelve changes inside one hunk: the hunk count and the change count are
  // different quantities, and a fixture where they happened to match would hide
  // a component that confused them.
  await expect(changeCounter(page, 'a')).toHaveText('1 / 12');
});

test('a front-matter-only edit reports changes in the toolbar and nothing in getHunks', async ({
  page,
}) => {
  await page.getByTestId('doc-a-front-matter-only').click();

  // The divergence, stated as plainly as it can be: the document changed, the
  // toolbar says so, and the hunk list — the thing a consumer would drive a
  // revert or an apply from — is empty. `computedHunks` is
  // `groupIntoHunks(lineDiffs)`, body only; `diffStats` sums body AND front
  // matter. The front-matter-inclusive grouping exists in the component
  // (`unifiedDiffHunks`) and is wired only to the copy-diff path.
  await expectHunks(page, 'hunks-a', []);
  await page.getByTestId('read-hunks-a').click();
  await expectHunks(page, 'imperative-a', []);

  // Exactly one stat badge, reading `~1`: the toolbar's stats sum body AND front
  // matter, so the one modified YAML line surfaces here while `getHunks()` — the
  // body-only grouping — reports nothing.
  await expect(viewer(page, 'a').locator('.stat-badge')).toHaveText('~1');
  await expect(viewer(page, 'a').locator('.front-matter-only-hint')).toHaveText(
    'Front matter only',
  );
  // `hasChanges` is true, so the "No changes" success badge must NOT be showing
  // — the toolbar and the hunk list genuinely disagree, rather than the toolbar
  // simply being empty too.
  await expect(viewer(page, 'a').locator('.no-changes')).toHaveCount(0);
  await expect(viewer(page, 'a').locator('.front-matter-section')).toHaveAttribute(
    'data-has-changes',
    'true',
  );
  await expect(viewer(page, 'a').locator('.front-matter-header .cinder-badge')).toHaveText(
    'Changed',
  );

  // And no body navigation exists, because there is no body change to navigate.
  await expect(changeCounter(page, 'a')).toHaveCount(0);
});

test('the displayed front matter is byte-identical to the authored front matter', async ({
  page,
}) => {
  await page.getByTestId('doc-a-front-matter-only').click();

  // Read through `allTextContents`, NOT `toHaveText`. Playwright's text matchers
  // normalise whitespace, which would silently "fix" the exact thing this test
  // exists to catch: `'  - dana'` compared as `'- dana'` passes against a
  // pipeline that flattened the sequence indentation.
  //
  // The array comparison covers the other half of that corruption too. An
  // injected blank line would appear as an extra row — `DiffLine` renders an
  // empty line as a non-breaking space, so it would show up as an unmistakable
  // extra element rather than as nothing.
  //
  // Asserted in `original` and `final` rather than `unified` because a modified
  // line renders word-level `<del>`/`<ins>` fragments in unified — its text
  // content is the two versions concatenated, which is not a line of either
  // document. In the other two modes each row is exactly one document's line.
  await page.getByTestId('set-mode-a-original').click();
  await expect(page.getByTestId('mode-a')).toHaveText('original');
  expect(await unchangedFrontMatterText(page, 'a').allTextContents()).toEqual(
    FRONT_MATTER_UNCHANGED,
  );
  await expect(changedFrontMatterText(page, 'a')).toHaveText('status: draft');

  await page.getByTestId('set-mode-a-final').click();
  await expect(page.getByTestId('mode-a')).toHaveText('final');
  expect(await unchangedFrontMatterText(page, 'a').allTextContents()).toEqual(
    FRONT_MATTER_UNCHANGED,
  );
  await expect(changedFrontMatterText(page, 'a')).toHaveText('status: ready');

  // Instance B has no front matter at all, which is what proves the block above
  // is driven by the document rather than always rendered.
  await expect(viewer(page, 'b').locator('.front-matter-section')).toHaveCount(0);
});

test('viewMode is bound in both directions, across all three modes', async ({ page }) => {
  // ROADMAP DV-1 says "both view modes". There are three — `unified`, `final`,
  // `original` — and the component's own `VIEW_MODES` array is what `Ctrl+Shift+D`
  // cycles. Two of three would leave one rendering branch unvisited.

  // Component to page: drive the segmented control the way a user does.
  for (const [label, mode] of [
    ['Final', 'final'],
    ['Original', 'original'],
    ['Unified', 'unified'],
  ] as const) {
    await modeRadio(page, 'a', label).click();
    await expect(page.getByTestId('mode-a')).toHaveText(mode);
    await expect(modeRadio(page, 'a', label)).toHaveAttribute('aria-checked', 'true');
  }

  // Page to component: write the bound prop from outside and watch the control
  // follow. Both directions are needed — a one-way binding would satisfy either
  // half on its own.
  for (const [mode, label] of [
    ['original', 'Original'],
    ['final', 'Final'],
    ['unified', 'Unified'],
  ] as const) {
    await page.getByTestId(`set-mode-a-${mode}`).click();
    await expect(modeRadio(page, 'a', label)).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('mode-a')).toHaveText(mode);
  }

  // Instance B is untouched throughout. It shares the page and nothing else.
  await expect(page.getByTestId('mode-b')).toHaveText('unified');
});

test('final hides removed lines, original hides added lines, and the change count follows', async ({
  page,
}) => {
  await page.getByTestId('doc-a-added-and-removed').click();
  await expectHunks(page, 'hunks-a', HUNKS_ADDED_AND_REMOVED);

  // Sixteen rows in unified: fifteen body lines plus the inserted one. One is
  // `added`, one is `removed`, and the visibility gate is what each mode moves.
  await expect(bodyLines(page, 'a')).toHaveCount(16);
  await expect(viewer(page, 'a').locator('.diff-content > .diff-line-added')).toHaveCount(1);
  await expect(viewer(page, 'a').locator('.diff-content > .diff-line-removed')).toHaveCount(1);
  await expect(changeCounter(page, 'a')).toHaveText('1 / 2');

  await page.getByTestId('set-mode-a-final').click();
  await expect(bodyLines(page, 'a')).toHaveCount(15);
  await expect(viewer(page, 'a').locator('.diff-content > .diff-line-added')).toHaveCount(1);
  await expect(viewer(page, 'a').locator('.diff-content > .diff-line-removed')).toHaveCount(0);
  // `changedLineIndices` is filtered by view mode too, so hiding a row also
  // removes it from the navigation. That coupling is easy to break and invisible
  // from the row counts alone.
  await expect(changeCounter(page, 'a')).toHaveText('1 / 1');

  await page.getByTestId('set-mode-a-original').click();
  await expect(bodyLines(page, 'a')).toHaveCount(15);
  await expect(viewer(page, 'a').locator('.diff-content > .diff-line-added')).toHaveCount(0);
  // In `original` a removed line loses its strikethrough and its `-` gutter, and
  // its class changes with it — so it is `.diff-line-removed-original` here, not
  // `.diff-line-removed`.
  await expect(
    viewer(page, 'a').locator('.diff-content > .diff-line-removed-original'),
  ).toHaveCount(1);
  await expect(changeCounter(page, 'a')).toHaveText('1 / 1');

  // Word-level markup exists only in unified. Asserted on the two-hunk fixture,
  // whose changes are `modified` lines — the only type that carries word changes.
  await page.getByTestId('doc-a-two-hunk').click();
  await page.getByTestId('set-mode-a-unified').click();
  await expect(viewer(page, 'a').locator('del.word-removed').first()).toHaveText('first');
  await expect(viewer(page, 'a').locator('ins.word-added').first()).toHaveText('second');
  await page.getByTestId('set-mode-a-final').click();
  await expect(viewer(page, 'a').locator('del.word-removed')).toHaveCount(0);
  await expect(viewer(page, 'a').locator('ins.word-added')).toHaveCount(0);
});
