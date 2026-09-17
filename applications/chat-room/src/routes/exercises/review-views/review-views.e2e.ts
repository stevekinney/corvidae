import { expect, test } from '@playwright/test';
import type { Page, ViewName } from './review-views-test-helpers';
import {
  CONTROLS,
  DIFF_PANEL,
  EDITOR_PANEL,
  SUMMARY_PANEL,
  VIEW_TABLIST,
  instance,
  openReviewViews,
  selectView,
  surface,
} from './review-views-test-helpers';

test.describe('review-views: the view tablist', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openReviewViews(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('one unified control bar hosts the view tablist and the formatting toolbar', async () => {
    const main = instance(page, 'views-main');
    await selectView(main, 'Editor');

    // There is exactly ONE control row. The formatting controls (undo, redo,
    // block type, overflow) are hosted INSIDE it, in `.controls-formatting`,
    // rather than in a second toolbar row stacked underneath — there is no
    // `.editor-toolbar-wrapper` anywhere.
    await expect(main.locator('.review-editor-controls')).toHaveCount(1);
    await expect(main.locator('.editor-toolbar-wrapper')).toHaveCount(0);
    await expect(main.locator(`${CONTROLS} .controls-formatting .editor-toolbar`)).toHaveCount(1);

    // BEHAVIOUR CHANGE: the outer bar used to be a second `role="toolbar"`
    // wrapping the editor's own `toolbar`, which is not a shape ARIA expects.
    // It is now `role="group"` with `aria-label="Review editor controls"`:
    // the bar hosts a `tablist` (never a valid child of `toolbar`) and, in
    // the editor view, the editor's `toolbar` (which may not nest inside
    // another `toolbar`). A labelled group describes what the bar is and
    // keeps both children valid.
    const bar = page.locator(CONTROLS);
    await expect(bar).toHaveAttribute('role', 'group');
    await expect(bar).toHaveAttribute('aria-label', 'Review editor controls');
    await expect(main.getByRole('toolbar', { name: 'Formatting toolbar' })).toHaveCount(1);

    // The tablist is labelled by an sr-only span rather than an aria-label,
    // so the accessible name comes from text the eye never sees.
    const tablist = page.locator(VIEW_TABLIST);
    await expect(tablist).toHaveAttribute('role', 'tablist');
    await expect(tablist).toHaveAttribute('aria-orientation', 'horizontal');
    await expect(tablist).toHaveAttribute('aria-labelledby', `${VIEW_TABLIST.slice(1)}-label`);
    await expect(page.locator(`${VIEW_TABLIST}-label`)).toHaveText('Review editor view');
    await expect(page.locator(`${VIEW_TABLIST}-label`)).toHaveClass(/cinder-sr-only/);

    // DOM order is Editor / Diff / Summary.
    await expect(tablist.getByRole('tab')).toHaveText(['Editor', 'Diff', 'Summary']);
  });

  test('selecting a tab sets data-view and swaps in exactly one panel', async () => {
    const main = instance(page, 'views-main');

    await selectView(main, 'Editor');
    await expect(main.getByRole('tabpanel')).toHaveCount(1);
    await expect(page.locator(EDITOR_PANEL)).toHaveAttribute('aria-label', 'Editor view');
    // The other two panels are not hidden — they do not exist.
    await expect(page.locator(DIFF_PANEL)).toHaveCount(0);
    await expect(page.locator(SUMMARY_PANEL)).toHaveCount(0);

    await selectView(main, 'Diff');
    await expect(main.getByRole('tabpanel')).toHaveCount(1);
    await expect(page.locator(DIFF_PANEL)).toHaveAttribute('aria-label', 'Diff view');
    await expect(page.locator(EDITOR_PANEL)).toHaveCount(0);
    await expect(page.locator(SUMMARY_PANEL)).toHaveCount(0);

    await selectView(main, 'Summary');
    await expect(main.getByRole('tabpanel')).toHaveCount(1);
    await expect(page.locator(SUMMARY_PANEL)).toHaveAttribute('aria-label', 'Summary view');
    await expect(page.locator(EDITOR_PANEL)).toHaveCount(0);
    await expect(page.locator(DIFF_PANEL)).toHaveCount(0);
  });

  test('only the selected tab carries aria-controls; unselected tabs carry none', async () => {
    const main = instance(page, 'views-main');

    // cinder#1303: every tab used to point at its panel id unconditionally,
    // so in each view two of the three `aria-controls` references dangled —
    // the view area renders exactly one panel at a time via an `{#if}`
    // chain, not three panels with two merely hidden, so an inactive tab's
    // target never existed in the document. Fixed by only passing `controls`
    // to the active segment, so an unselected tab now omits `aria-controls`
    // entirely rather than pointing it at a nonexistent id — a dangling
    // reference fails axe's `aria-valid-attr-value` and any screen reader
    // that follows the tab-to-panel relationship, where an absent attribute
    // simply doesn't claim to control anything (yet).
    const panelIds = { Editor: EDITOR_PANEL, Diff: DIFF_PANEL, Summary: SUMMARY_PANEL } as const;
    for (const view of ['Editor', 'Diff', 'Summary'] as const) {
      await selectView(main, view);
      for (const tab of ['Editor', 'Diff', 'Summary'] as const) {
        const tabLocator = main.getByRole('tab', { name: tab });
        if (tab === view) {
          await expect(tabLocator).toHaveAttribute('aria-controls', panelIds[tab].slice(1));
        } else {
          await expect(tabLocator).not.toHaveAttribute('aria-controls');
        }
        await expect(page.locator(panelIds[tab])).toHaveCount(tab === view ? 1 : 0);
      }
    }
  });

  test('arrow keys activate automatically, answer both axes, and wrap', async () => {
    const main = instance(page, 'views-main');
    await selectView(main, 'Editor');

    const tab = (name: ViewName) => main.getByRole('tab', { name });
    // Roving tabindex: only the selected tab is in the tab order.
    await expect(tab('Editor')).toHaveAttribute('tabindex', '0');
    await expect(tab('Diff')).toHaveAttribute('tabindex', '-1');

    await tab('Editor').focus();

    // Activation is automatic — moving focus also changes the view. Focus
    // moves synchronously but `aria-selected`/`data-view` flush on a later
    // microtask, so every assertion below goes through auto-retrying
    // `expect`; a synchronous read straight after `press` would race.
    await page.keyboard.press('ArrowRight');
    await expect(surface(main)).toHaveAttribute('data-view', 'diff');
    await expect(tab('Diff')).toHaveAttribute('aria-selected', 'true');
    await expect(tab('Diff')).toBeFocused();

    // The tablist declares `aria-orientation="horizontal"` yet answers the
    // vertical arrows too: the roving helper is invoked with both axes
    // enabled unless the orientation is explicitly vertical.
    await page.keyboard.press('ArrowDown');
    await expect(surface(main)).toHaveAttribute('data-view', 'summary');
    await expect(tab('Summary')).toHaveAttribute('aria-selected', 'true');

    // Forward from the last tab wraps to the first.
    await page.keyboard.press('ArrowRight');
    await expect(surface(main)).toHaveAttribute('data-view', 'editor');
    await expect(tab('Editor')).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('End');
    await expect(surface(main)).toHaveAttribute('data-view', 'summary');

    await page.keyboard.press('ArrowLeft');
    await expect(surface(main)).toHaveAttribute('data-view', 'diff');

    await page.keyboard.press('ArrowUp');
    await expect(surface(main)).toHaveAttribute('data-view', 'editor');

    await page.keyboard.press('End');
    await expect(surface(main)).toHaveAttribute('data-view', 'summary');
    await page.keyboard.press('Home');
    await expect(surface(main)).toHaveAttribute('data-view', 'editor');
    await expect(tab('Editor')).toBeFocused();
    await expect(tab('Summary')).toHaveAttribute('tabindex', '-1');
  });
});

test.describe('review-views: the baseline gate and diff statistics', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openReviewViews(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('statistics summarise the fixture and omit the zero category', async () => {
    const stats = instance(page, 'views-main').locator('.cinder-diff-statistics');
    await expect(stats).toHaveAttribute('role', 'group');

    // The group's own label is the TOTAL of the three counts — one added
    // line plus one modified line reads as "2 lines changed", not "2 lines
    // added". Each surviving stat carries its own pluralised label.
    await expect(stats).toHaveAttribute('aria-label', '2 lines changed');
    await expect(stats.locator('[aria-label="1 line added"]')).toHaveCount(1);
    await expect(stats.locator('[aria-label="1 line modified"]')).toHaveCount(1);

    // `zeroVisible={false}`: the removed category is dropped entirely rather
    // than rendered as "0 removed".
    await expect(stats.locator('.cinder-diff-statistics__stat--removed')).toHaveCount(0);
    await expect(stats.locator('.cinder-diff-statistics__stat')).toHaveCount(2);

    // DiffStatistics has a "No changes" chip for the all-zero case, but the
    // control bar only mounts the component when at least one count is
    // non-zero, so that chip is unreachable from ReviewEditor by
    // construction — not merely absent for this fixture.
    await expect(page.locator('.cinder-diff-statistics__stat--none')).toHaveCount(0);
  });

  test('the statistics chip is a property of the document, not of the active view', async () => {
    const main = instance(page, 'views-main');
    for (const view of ['Diff', 'Summary', 'Editor'] as const) {
      await selectView(main, view);
      await expect(main.locator('.cinder-diff-statistics')).toHaveCount(1);
    }
  });

  test('an omitted `original` collapses the surface to the Editor tab alone', async () => {
    // `showDiffTabs={!!original}` and the wrapper defaults `original` to `''`,
    // so omitting the prop is the same as passing an empty string.
    const scope = instance(page, 'views-no-original');
    await expect(scope.getByRole('tab')).toHaveCount(1);
    await expect(scope.getByRole('tab')).toHaveText(['Editor']);
    await expect(scope.locator('.cinder-diff-statistics')).toHaveCount(0);
    await expect(scope.getByLabel('Revert all changes')).toHaveCount(0);
    // A tablist is still rendered — it just has nothing to switch between.
    await expect(scope.getByRole('tablist')).toHaveCount(1);
  });

  test('an empty-string `original` behaves identically to an omitted one', async () => {
    const scope = instance(page, 'views-empty-original');
    await expect(scope.getByRole('tab')).toHaveCount(1);
    await expect(scope.getByRole('tab')).toHaveText(['Editor']);
    await expect(scope.locator('.cinder-diff-statistics')).toHaveCount(0);
    await expect(scope.getByLabel('Revert all changes')).toHaveCount(0);
  });
});
