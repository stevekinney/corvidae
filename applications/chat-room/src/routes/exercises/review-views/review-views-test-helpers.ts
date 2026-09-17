import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { gotoHydrated } from '../hydration';

export { gotoHydrated };
export type { Locator, Page };

export // ReviewEditor's view layer: the editor/diff/summary tablist, the diff
// view-mode radiogroup, DiffStatistics, and Revert All.
//
// Boundaries with the sibling routes: `review-ssr-and-a11y` owns every live
// region (including the "Switched to diff view" announcement, which is
// `cinder-sr-only` and therefore NOT reachable through a visible-text locator)
// and every pre-hydration/SSR assertion. `review-modes` owns readonly
// mechanics — the readonly instance appears here only to show that Revert All
// is gated on `!readonly`.

/** Every derived id on the main instance descends from `id="views-editor"`. */
const CONTROLS = '#views-editor-controls';
export const VIEW_TABLIST = '#views-editor-controls-view-mode';
export const DIFF_MODE_GROUP = '#views-editor-controls-diff-view-mode';
export const EDITOR_PANEL = '#views-editor-editor-panel';
export const DIFF_PANEL = '#views-editor-diff-panel';
export const SUMMARY_PANEL = '#views-editor-summary-panel';

export type ViewName = 'Editor' | 'Diff' | 'Summary';

/** The page wraps each ReviewEditor in its own testid; the component's own
 *  container is `[data-testid="review-editor"]` and carries no id, so every
 *  locator has to be scoped through the wrapper. */
export function instance(page: Page, testId: string): Locator {
  return page.getByTestId(testId);
}

export function surface(scope: Locator): Locator {
  return scope.getByTestId('review-editor');
}

export async function openReviewViews(page: Page): Promise<void> {
  await gotoHydrated(page, '/exercises/review-views');
  // `data-ready` is the right signal for the FIRST interaction only. See the
  // comment on `selectView` for why it is still the wrong one to wait on
  // after that, even though it no longer lies once the editor unmounts.
  await expect(surface(instance(page, 'views-main'))).toHaveAttribute('data-ready', 'true');
}

/**
 * Click a view tab and wait for the swap.
 *
 * The settle signal is `data-view`, never `data-ready`. `data-ready` mirrors
 * `editorViewReady`, which the component now resets (cinder#1301) via an
 * effect keyed on `editorRef` itself, so the attribute is absent for the
 * whole time no `MarkdownEditor` is mounted — the Diff/Summary views, and the
 * gap while a fresh one is mounting on the way back. That fixed a real bug
 * (it used to stay `"true"` forever after the first mount), but it still
 * means `data-ready` answers "is *some* editor mounted and ready", not "did
 * the view finish switching": waiting on it after a view switch waits for the
 * remount, one tick behind `data-view`, or for nothing at all in the
 * Diff/Summary direction. When the editor pane itself is what matters, wait
 * on `.ProseMirror`.
 */
export async function selectView(scope: Locator, name: ViewName): Promise<void> {
  await scope.getByRole('tab', { name }).click();
  await expect(surface(scope)).toHaveAttribute('data-view', name.toLowerCase());
}
