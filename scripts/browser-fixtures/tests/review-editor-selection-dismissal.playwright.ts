/**
 * Regression for the Escape / selection-refocus race in `ReviewEditor`.
 *
 * Dismissing the selection popover with Escape hands focus back to the
 * editor, and ProseMirror may re-write its stored (non-collapsed) selection
 * into the DOM. The resulting `selectionchange` must not reopen the popover
 * over text the user just dismissed it for. `consumedSelection` in
 * `review-editor-impl.svelte` is the latch that prevents it; a deliberate
 * pointer reselection of the same range must still release it.
 *
 * The clock is installed before navigation so the 20ms selection debounce is
 * advanced explicitly instead of being waited out.
 */
import { reviewEditorCommentsRoute } from './review-editor-accessibility-route.ts';
import { expect, test } from './review-editor-browser-errors.ts';

const MOUNT = '#example-mount-with-comments';

test('Escape dismissal survives a collapsed-then-restored selection, and pointer reselection reopens it', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto(reviewEditorCommentsRoute, { waitUntil: 'load' });
  await expect(page.locator(`${MOUNT} [data-testid="review-editor"]`)).toHaveAttribute(
    'data-ready',
    'true',
  );

  const paragraph = page.locator(`${MOUNT} .ProseMirror p`).first();
  const popover = page.getByRole('toolbar', { name: 'Selection actions' });

  await paragraph.dblclick({ position: { x: 20, y: 8 } });
  await page.clock.runFor(100);
  await expect(popover).toBeVisible();

  await page.keyboard.press('Escape');
  await page.clock.runFor(1000);
  await expect(popover).toHaveCount(0);

  // Collapse the DOM selection, then put the same range back: the shape of
  // ProseMirror re-writing its stored selection during the focus hand-off.
  await page.evaluate(() => {
    const selection = getSelection();
    if (selection === null || selection.rangeCount === 0) throw new Error('Expected a selection.');
    const range = selection.getRangeAt(0).cloneRange();
    selection.collapseToStart();
    document.dispatchEvent(new Event('selectionchange'));
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.clock.runFor(200);
  await expect(popover).toHaveCount(0);

  // A deliberate pointer reselection of the same word offers the popover again.
  await paragraph.dblclick({ position: { x: 20, y: 8 } });
  await page.clock.runFor(200);
  await expect(popover).toBeVisible();
});
