import { expect, test } from '@playwright/test';
import type { Page } from './review-views-test-helpers';
import {
  DIFF_MODE_GROUP,
  instance,
  openReviewViews,
  selectView,
} from './review-views-test-helpers';

test.describe('review-views: the diff panel', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openReviewViews(page);
    await selectView(instance(page, 'views-main'), 'Diff');
  });

  test.afterAll(async () => {
    await page.close();
  });

  /** Reset to Unified so each test starts from the same mode regardless of
   *  the order it runs in. */
  async function useMode(name: 'Unified' | 'Final' | 'Original'): Promise<void> {
    const radio = page.locator(DIFF_MODE_GROUP).getByRole('radio', { name });
    await radio.click();
    await expect(radio).toHaveAttribute('aria-checked', 'true');
  }

  test('the diff view-mode control is a radiogroup, not a second tablist', async () => {
    const main = instance(page, 'views-main');
    await selectView(main, 'Diff');
    const group = page.locator(DIFF_MODE_GROUP);

    // Only ONE tablist exists on this surface. The diff modes are radios:
    // they choose how the same panel renders, they do not swap panels, so
    // they carry `aria-checked` and — unlike the view tabs — no
    // `aria-controls` at all.
    await expect(main.getByRole('tablist')).toHaveCount(1);
    await expect(group).toHaveAttribute('role', 'radiogroup');
    await expect(group).toHaveAttribute('aria-labelledby', `${DIFF_MODE_GROUP.slice(1)}-label`);
    await expect(page.locator(`${DIFF_MODE_GROUP}-label`)).toHaveText('Diff view mode');
    await expect(group.getByRole('radio')).toHaveText(['Unified', 'Final', 'Original']);
    await expect(group.locator('[role="radio"][aria-controls]')).toHaveCount(0);

    // Roving tabindex, same as the tablist: only the checked radio is in the
    // tab order.
    await useMode('Unified');
    await expect(group.getByRole('radio', { name: 'Unified' })).toHaveAttribute('tabindex', '0');
    await expect(group.getByRole('radio', { name: 'Final' })).toHaveAttribute('tabindex', '-1');
  });

  test('the radiogroup is diff-only, and a separator precedes whichever optional cluster the bar has', async () => {
    const main = instance(page, 'views-main');

    // BEHAVIOUR CHANGE: the separator used to be diff-exclusive — the control
    // bar emitted one only ahead of the diff-mode radiogroup, so the editor
    // view had none. The bar now emits `.controls-separator` ahead of BOTH
    // optional trailing clusters: one before `.controls-formatting` (editor
    // view) and one before the radiogroup (diff view). The two clusters are
    // mutually exclusive — the formatting toolbar only exists while the
    // editor is mounted — so the count is still never more than one, and the
    // separator is still absent in Summary, which has neither cluster.
    const separator = main.locator('.controls-separator');

    await selectView(main, 'Editor');
    await expect(page.locator(DIFF_MODE_GROUP)).toHaveCount(0);
    await expect(separator).toHaveCount(1);
    await expect(separator).toHaveAttribute('aria-hidden', 'true');
    // It leads the formatting cluster rather than the radiogroup here.
    await expect(main.locator('.controls-separator + .controls-formatting')).toHaveCount(1);

    // Summary mounts no editor and no diff controls, so there is nothing for a
    // separator to divide and none is rendered.
    await selectView(main, 'Summary');
    await expect(page.locator(DIFF_MODE_GROUP)).toHaveCount(0);
    await expect(separator).toHaveCount(0);

    await selectView(main, 'Diff');
    await expect(page.locator(DIFF_MODE_GROUP)).toHaveCount(1);
    await expect(main.locator('.controls-formatting')).toHaveCount(0);
    await expect(separator).toHaveCount(1);
    // The separator is decorative and hidden from the accessibility tree.
    await expect(separator).toHaveAttribute('aria-hidden', 'true');
  });

  test('unified mode shows word-level changes on a modified row', async () => {
    const main = instance(page, 'views-main');
    await selectView(main, 'Diff');
    await useMode('Unified');

    // Nine rows: seven unchanged, one modified, one added.
    await expect(main.locator('.diff-line')).toHaveCount(9);
    await expect(main.locator('.diff-line-modified')).toHaveCount(1);
    await expect(main.locator('.diff-line-added')).toHaveCount(1);
    await expect(main.locator('.diff-line-removed')).toHaveCount(0);

    // The modified row's gutter marks it `~`, and only unified mode renders
    // the intra-line word diff.
    await expect(main.locator('.diff-line-modified .diff-gutter')).toHaveText('~');
    await expect(main.locator('del.word-removed')).toHaveCount(1);
    await expect(main.locator('ins.word-added')).toHaveCount(2);

    // Changed rows are real buttons with a spoken label; unchanged rows are
    // plain divs carrying no label at all, so a screen reader walks past them.
    const changed = main.locator('button.diff-line');
    await expect(changed).toHaveCount(2);
    await expect(main.getByRole('button', { name: /^Modified line:/ })).toHaveCount(1);
    await expect(main.getByRole('button', { name: /^Added line:/ })).toHaveCount(1);
    await expect(main.locator('div.diff-line')).toHaveCount(7);
    await expect(main.locator('div.diff-line[aria-label]')).toHaveCount(0);

    // In unified mode the modified row's label carries BOTH sides.
    await expect(main.getByRole('button', { name: /^Modified line:/ })).toHaveAttribute(
      'aria-label',
      / changed to /,
    );
  });

  test('final mode keeps every row but renders only the new text', async () => {
    const main = instance(page, 'views-main');
    await selectView(main, 'Diff');
    await useMode('Final');

    // Row count is unchanged (the fixture removes nothing), but the modified
    // row swaps its modifier class and drops the inline word diff.
    await expect(main.locator('.diff-line')).toHaveCount(9);
    await expect(main.locator('.diff-line-modified-final')).toHaveCount(1);
    await expect(main.locator('.diff-line-modified')).toHaveCount(0);
    await expect(main.locator('.diff-line-added')).toHaveCount(1);
    await expect(main.locator('del.word-removed')).toHaveCount(0);
    await expect(main.locator('ins.word-added')).toHaveCount(0);

    // The label now names only the post-edit text.
    const modified = main.getByRole('button', { name: /^Modified line:/ });
    await expect(modified).toHaveAttribute('aria-label', /and inline review\.$/);
    await expect(modified).not.toHaveAttribute('aria-label', / changed to /);
  });

  test('original mode drops added rows entirely and shows the baseline text', async () => {
    const main = instance(page, 'views-main');
    await selectView(main, 'Diff');
    await useMode('Original');

    // The added row is not merely restyled — it is gone, so the row count
    // falls from nine to eight.
    await expect(main.locator('.diff-line')).toHaveCount(8);
    await expect(main.locator('.diff-line-added')).toHaveCount(0);
    await expect(main.getByRole('button', { name: /^Added line:/ })).toHaveCount(0);
    await expect(main.locator('.diff-line-modified-original')).toHaveCount(1);

    const modified = main.getByRole('button', { name: /^Modified line:/ });
    await expect(modified).toHaveAttribute('aria-label', /a dashboard and export actions\.$/);
  });

  test("ReviewEditor suppresses DiffViewer's own toolbar and hunk chrome", async () => {
    const main = instance(page, 'views-main');
    await selectView(main, 'Diff');

    // ReviewEditor passes DiffViewer an EMPTY `toolbar` snippet, which
    // overrides the default one wholesale: no view-mode duplicate, no change
    // navigation, no copy or manual-compute button. Hunk headers disappear
    // for a different reason — they render only when `onreverthunk` is
    // supplied, and ReviewEditor never supplies it.
    await expect(main.locator('.diff-toolbar')).toHaveCount(0);
    await expect(main.locator('.hunk-header')).toHaveCount(0);
    await expect(main.locator('.hunk-revert-button')).toHaveCount(0);
    for (const name of ['Next change', 'Previous change', 'Copy unified diff', 'Compute Diff']) {
      await expect(main.getByRole('button', { name })).toHaveCount(0);
    }
  });

  test("DiffViewer's keyboard shortcuts are scoped to focus inside its own subtree, not the window", async () => {
    // FIXED contract as of `@repo/editor@0.10.0` (cinder#1310). The
    // handler moved from a bare `<svelte:window onkeydown>` onto DiffViewer's
    // own root element, relying on DOM event bubbling — so a keystroke only
    // reaches it when the currently focused element is inside that instance's
    // own subtree. `ReviewEditor`'s OWN mode-switcher radiogroup
    // (`DIFF_MODE_GROUP`, id-prefixed `views-editor-controls-…`) is rendered
    // by ReviewEditor itself, alongside DiffViewer rather than inside its
    // `toolbar` snippet (which this route passes empty — see "ReviewEditor
    // suppresses DiffViewer's own toolbar and hunk chrome" above) — so even
    // ReviewEditor's own controls are now OUTSIDE the scope that fires these
    // shortcuts. The one thing genuinely inside DiffViewer's own subtree here
    // is the diff content itself: each diff line renders as a
    // `role="button"`, and focusing one is what makes the shortcuts fire.
    const main = instance(page, 'views-main');
    // Round-trip through the editor first so the DiffViewer below is a fresh
    // mount — otherwise "auto-selected on mount" would be asserting about
    // whatever a previous test left behind.
    await selectView(main, 'Editor');
    await selectView(main, 'Diff');
    await useMode('Unified');

    const group = page.locator(DIFF_MODE_GROUP);
    const mode = (name: string) => group.getByRole('radio', { name });

    // The first change is auto-selected on mount without any interaction.
    const selected = main.locator('.diff-line[data-selected="true"]');
    await expect(selected).toHaveAttribute('aria-label', /^Modified line:/);

    // Focus OUTSIDE every DiffViewer instance: clicking a page heading leaves
    // `document.activeElement` on `<body>`. This now fires nothing — a
    // deliberate behavior change from the old global listener, not only a
    // bug fix. Proven with a causal barrier (`useMode` has its own
    // observable effect) rather than a bare absence-of-change assertion,
    // which could equally pass because nothing had happened yet.
    await page.getByRole('heading', { name: 'Views and diff' }).click();
    await page.keyboard.press(']');
    await page.keyboard.press('Control+Shift+D');
    await useMode('Final');
    await useMode('Unified');
    await expect(selected).toHaveAttribute('aria-label', /^Modified line:/);

    // Focus a diff line — genuinely inside DiffViewer's own Surface root —
    // and the same shortcuts now work. `]` / `[` walk the changed rows and
    // wrap at both ends.
    await selected.focus();
    await page.keyboard.press(']');
    await expect(main.locator('.diff-line[data-selected="true"]')).toHaveAttribute(
      'aria-label',
      /^Added line:/,
    );
    await page.keyboard.press(']');
    await expect(main.locator('.diff-line[data-selected="true"]')).toHaveAttribute(
      'aria-label',
      /^Modified line:/,
    );
    await page.keyboard.press('[');
    await expect(main.locator('.diff-line[data-selected="true"]')).toHaveAttribute(
      'aria-label',
      /^Added line:/,
    );

    // Ctrl+Shift+D cycles Unified → Final → Original → Unified, and the
    // toolbar radiogroup follows because both read the same bound
    // `diffViewMode` — even though the radiogroup itself sits outside
    // DiffViewer's own subtree, the keystroke that changes the bound value
    // still has to originate INSIDE it. Note the modifier is literally
    // Control on every platform — the handler checks `event.ctrlKey`, so
    // macOS does not get the Cmd-based chord it would expect. Focus stays on
    // the same diff-line button across all three presses: each mode change
    // re-renders the diff body, but does not move focus away from it.
    await expect(mode('Unified')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Control+Shift+D');
    await expect(mode('Final')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Control+Shift+D');
    await expect(mode('Original')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Control+Shift+D');
    await expect(mode('Unified')).toHaveAttribute('aria-checked', 'true');
  });
});
