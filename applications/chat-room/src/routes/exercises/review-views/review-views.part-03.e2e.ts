import { expect, test } from '@playwright/test';
import type { Page } from './review-views-test-helpers';
import {
  DIFF_MODE_GROUP,
  instance,
  openReviewViews,
  selectView,
  surface,
} from './review-views-test-helpers';

test.describe('review-views: the summary panel', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openReviewViews(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('the summary is a readonly editor showing changes and feedback', async () => {
    const main = instance(page, 'views-main');
    await selectView(main, 'Summary');

    // The summary is rendered by a second MarkdownEditor mounted readonly —
    // a real ProseMirror document, not static HTML — so the markdown
    // structure is inspectable as headings.
    const summary = main.locator('.ProseMirror');
    await expect(summary).toHaveAttribute('contenteditable', 'false');
    await expect(main.locator('.editor-toolbar')).toHaveCount(0);

    await expect(main.getByRole('heading', { name: 'Changes Made', level: 2 })).toBeVisible();
    await expect(main.getByRole('heading', { name: 'Feedback', level: 2 })).toBeVisible();
    // Thread commentary is keyed by the anchor's quote.
    await expect(main.getByRole('heading', { name: 'On "Release Plan"', level: 3 })).toBeVisible();
    await expect(summary).toContainText('Title reads well');

    // The generator emits a `# Review Summary` title for clipboard exports,
    // and the view strips it before rendering: the tab already says
    // "Summary", so repeating it in the document would be noise.
    await expect(summary).not.toContainText('Review Summary');
  });

  test('with nothing changed and no threads the summary falls back to an empty region', async () => {
    const scope = instance(page, 'views-summary-empty');
    await selectView(scope, 'Summary');

    // `original === value` and `threads: []` is the only combination that
    // takes this branch — a single thread on an unedited document would
    // still generate a document.
    const region = scope.locator('.summary-view');
    await expect(region).toHaveAttribute('role', 'region');
    await expect(region).toHaveAttribute('aria-label', 'Review summary');
    await expect(region).toContainText('No changes or comments to summarize.');
    await expect(scope.locator('.summary-hint')).toContainText(
      'Edit the document or add comments to generate a summary.',
    );
    // No MarkdownEditor is mounted at all on this branch.
    await expect(scope.locator('.ProseMirror')).toHaveCount(0);
  });
});

test.describe('review-views: revert all', () => {
  let page: Page;

  // Revert All rewrites `value`, so this describe owns its own page — the
  // mutation is not something the read-only describes above should inherit.
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openReviewViews(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('Revert All is absent outside the diff view and absent when readonly', async () => {
    const main = instance(page, 'views-main');

    // The button is gated on `activeView === 'diff' && hasContentChanges &&
    // !readonly`. First two thirds of that gate:
    await selectView(main, 'Editor');
    await expect(main.getByLabel('Revert all changes')).toHaveCount(0);
    await selectView(main, 'Summary');
    await expect(main.getByLabel('Revert all changes')).toHaveCount(0);
    await selectView(main, 'Diff');
    await expect(main.getByLabel('Revert all changes')).toHaveCount(1);

    // Last third: an otherwise identical readonly instance reaches the diff
    // view — statistics and all — and still offers no way to revert.
    // (`review-modes` owns everything else about readonly.)
    const readonly = instance(page, 'views-readonly');
    await selectView(readonly, 'Diff');
    await expect(readonly.locator('.cinder-diff-statistics')).toHaveCount(1);
    await expect(readonly.locator('.diff-line')).toHaveCount(9);
    await expect(readonly.getByLabel('Revert all changes')).toHaveCount(0);
    // Put it back so its DiffViewer stops listening for window keystrokes.
    await selectView(readonly, 'Editor');
  });

  test('Revert All restores the baseline, fires onchange once, and stays in the diff view', async () => {
    const main = instance(page, 'views-main');
    await selectView(main, 'Diff');

    const revert = main.getByRole('button', { name: 'Revert all changes' });
    // Icon-only button: the visible label is sr-only text behind the
    // aria-label, and the same string doubles as the tooltip.
    await expect(revert).toHaveAttribute('title', 'Revert all changes');
    await expect(revert.locator('.cinder-sr-only')).toHaveText('Revert All');
    await expect(page.getByTestId('change-count')).toHaveText('changes: 0');
    await expect(page.getByTestId('value-equals-original')).toHaveText(
      'value equals original: false',
    );

    await revert.click();

    // `value` becomes `original` exactly, and `onchange` fires once with
    // that same string — the component does not also emit an intermediate
    // value on the way there.
    await expect(page.getByTestId('value-equals-original')).toHaveText(
      'value equals original: true',
    );
    await expect(page.getByTestId('change-count')).toHaveText('changes: 1');
    await expect(page.getByTestId('last-change-is-original')).toHaveText(
      'last change is original: true',
    );

    // The surface does not bounce back to the editor: it stays on the diff
    // view, now showing an all-unchanged document.
    await expect(surface(main)).toHaveAttribute('data-view', 'diff');
    await expect(main.locator('.diff-line')).toHaveCount(8);
    await expect(main.locator('button.diff-line')).toHaveCount(0);

    // The statistics chip and the button itself both disappear, because both
    // hang off `hasContentChanges`, which is now false…
    await expect(main.locator('.cinder-diff-statistics')).toHaveCount(0);
    await expect(main.getByLabel('Revert all changes')).toHaveCount(0);

    // …but the tabs and the diff radios are gated on `original` and on
    // `activeView`, not on whether anything changed, so they all survive.
    await expect(main.getByRole('tab')).toHaveText(['Editor', 'Diff', 'Summary']);
    await expect(page.locator(DIFF_MODE_GROUP).getByRole('radio')).toHaveText([
      'Unified',
      'Final',
      'Original',
    ]);
  });
});

test.describe('review-views: leaving the editor view destroys the editor', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openReviewViews(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('the ProseMirror instance is discarded and rebuilt, taking undo history with it', async () => {
    const main = instance(page, 'views-main');
    await selectView(main, 'Editor');

    const editorPane = main.locator('.ProseMirror');
    await expect(editorPane).toBeVisible();

    // Make one real edit so there is undo history to lose. `pressSequentially`
    // drives ProseMirror through genuine input events; writing to the DOM
    // directly would not register a transaction. Click the first paragraph
    // rather than the editor's centre — clicking decorated text (the seeded
    // thread's anchor sits on the title) opens the thread popover instead of
    // placing a caret.
    const undo = main.getByRole('button', { name: 'Undo' });
    await expect(undo).toBeDisabled();
    await editorPane.locator('p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' now');
    await expect(undo).toBeEnabled();

    const lengthAfterEdit = await page.getByTestId('value-length').textContent();

    // Stamp the live node so its identity is checkable after the round trip.
    await editorPane.evaluate((node) => node.setAttribute('data-probe', 'first'));

    await selectView(main, 'Diff');
    // The editor is gone, not hidden — and so is the formatting toolbar that
    // was hosted in the control bar.
    await expect(main.locator('.ProseMirror')).toHaveCount(0);
    await expect(main.locator('.controls-formatting')).toHaveCount(0);
    // `data-ready` used to be STICKY (cinder#1301): it kept claiming the
    // editor was ready even after it unmounted, because the latch behind it
    // was set once and never cleared. Fixed by deriving the reset from
    // `editorRef` itself, so the attribute is now correctly absent for as
    // long as no editor is mounted — pinned here, not just in
    // `review-ssr-and-a11y`'s own coverage of the same fix, because this is
    // the test that actually drives an editor through the unmount.
    await expect(surface(main)).not.toHaveAttribute('data-ready');

    await selectView(main, 'Editor');
    await expect(main.locator('.ProseMirror')).toBeVisible();
    // …and comes back once the remounted editor reports ready again.
    await expect(surface(main)).toHaveAttribute('data-ready', 'true');

    // A different DOM node: the stamp did not come back with it.
    await expect(main.locator('.ProseMirror')).not.toHaveAttribute('data-probe', 'first');
    await expect(main.locator('.ProseMirror[data-probe]')).toHaveCount(0);

    // The document survives, because it lives in the bindable `value` rather
    // than in the editor…
    await expect(page.getByTestId('value-length')).toHaveText(lengthAfterEdit ?? '');
    // …but undo history does not: a peek at the diff silently throws away
    // every step the user could have undone.
    await expect(main.getByRole('button', { name: 'Undo' })).toBeDisabled();

    // Nor does focus return to the editor — it lands back on the body, so a
    // keyboard user has to find their way in again.
    await expect(main.locator('.ProseMirror')).not.toBeFocused();
  });
});
