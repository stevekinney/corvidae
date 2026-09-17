import { expect, test } from '@playwright/test';
import type { Page } from './review-views-test-helpers';
import { instance, openReviewViews, selectView } from './review-views-test-helpers';

test.describe('review-views: the comments sidebar outlives view switches', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openReviewViews(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('sidebar open state is independent of the active view', async () => {
    const main = instance(page, 'views-main');
    await selectView(main, 'Editor');

    // The toggle's accessible name carries both the next action and the
    // comment count, so it changes when the sidebar opens.
    const toggle = main.getByRole('button', { name: 'Open comments sidebar (1 comment)' });

    // While the sidebar is closed its `aria-controls` target does not exist —
    // the aside is behind an `{#if sidebarOpen}`, so the reference dangles
    // until it is opened. Worth knowing before trusting the attribute.
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-controls', 'views-editor-sidebar');
    await expect(page.locator('#views-editor-sidebar')).toHaveCount(0);

    await toggle.click();
    const opened = main.getByRole('button', { name: 'Close comments sidebar (1 comment)' });
    await expect(opened).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#views-editor-sidebar')).toHaveCount(1);

    // Only `.review-editor-main` swaps on a view change; the sidebar is a
    // sibling of it, so it stays mounted the whole way round.
    for (const view of ['Diff', 'Summary', 'Editor'] as const) {
      await selectView(main, view);
      await expect(page.locator('#views-editor-sidebar')).toHaveCount(1);
      await expect(opened).toHaveAttribute('aria-expanded', 'true');
    }
  });
});

test.describe('review-views: the toolbar and the panel normalise differently', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openReviewViews(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  // PINNED KNOWN BUG — this is wrong behaviour, pinned deliberately so a fix
  // shows up as a failing test rather than passing unnoticed.
  //
  // ReviewEditor computes `diffStats` by running both documents through
  // `normalize()` from the markdown pipeline, which canonicalises `__bold__`
  // to `**bold**`. The DiffViewer it renders in the same panel runs its own
  // regex `normalizeForDiff()`, which does no such canonicalisation. Give the
  // two the same document with only its bold syntax changed and they disagree
  // outright: the toolbar counts zero changes, so it shows no statistics chip
  // and — because Revert All hangs off `hasContentChanges` — offers no way to
  // revert, while the panel underneath renders a modified row for the very
  // difference the toolbar says does not exist.
  //
  // The fix is for both to share one normaliser. Until then, a formatting-only
  // edit is visible but unrevertable.
  test('a formatting-only edit renders as a modified row the toolbar cannot see', async () => {
    const scope = instance(page, 'views-formatting-only');
    await selectView(scope, 'Diff');

    // The panel sees the change…
    await expect(scope.locator('.diff-line-modified')).toHaveCount(1);
    await expect(scope.getByRole('button', { name: /^Modified line:/ })).toHaveAttribute(
      'aria-label',
      /__first__ .* changed to .*\*\*first\*\*/,
    );

    // …and the toolbar does not.
    await expect(scope.locator('.cinder-diff-statistics')).toHaveCount(0);
    await expect(scope.getByLabel('Revert all changes')).toHaveCount(0);

    // The Diff and Summary tabs are still offered, because `showDiffTabs`
    // keys off `!!original` rather than off the stats — so the surface
    // invites you into a view whose own controls have given up on it.
    await expect(scope.getByRole('tab')).toHaveText(['Editor', 'Diff', 'Summary']);
  });
});
