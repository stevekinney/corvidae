import { loadManifest } from '@lostgradient/testing';
import { expect, test, type Page } from '@playwright/test';

const manifest = loadManifest();

function fixtureRoute(slug: string, extra: string): string {
  const entry = manifest.find((candidate) => candidate.slug === slug);
  const hash = entry?.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined) throw new Error(`Assertion fixture hash missing for ${slug}.`);
  return `/page/${slug}?snapshot=1&fixture=assertion&fixtureContentHash=${hash}&${extra}`;
}

async function goto(page: Page): Promise<void> {
  await page.goto(fixtureRoute('diff-review', 'states=1'), { waitUntil: 'load' });
  await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
}

/**
 * COR-511 / DR-8: current -> outdated -> removed comment navigation inside
 * `DiffReview` itself. `DiffReviewCommentItem`'s own classification and
 * "never focus a current row" rule are unit-tested; this is the real-browser
 * proof that `DiffReview`'s public `targets`-prop update path (the one a real
 * host uses, via `reduceDiffReviewState`'s `set-targets` action) actually
 * drives that same classification end to end, and that "Go to" really moves
 * DOM focus rather than merely rendering a badge.
 */
test.describe('Diff review — current, outdated, and removed comment navigation', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('Go to focuses the live anchor for a current comment, and the captured detail (never a diff control) once it goes outdated or removed', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-navigation');
    const control = mount.locator(
      '[data-cinder-annotation-control][data-cinder-side="new"][data-cinder-line="1"]',
    );
    const composer = mount.getByLabel('Comment', { exact: true });
    const composerPanel = mount.locator('.diff-review-composer');

    // Save a real, current line comment.
    await control.click();
    await composer.fill('This should mention the CLI too.');
    await composerPanel.getByRole('button', { name: 'Save', exact: true }).click();
    const item = mount.locator('.diff-review-comment-item');
    await expect(item).toHaveAttribute('data-anchor-status', 'current');

    // A file-level comment on the same (still current) target, to prove
    // "unavailable" navigation separately from outdated/removed status:
    // `DiffReviewRenderer.focusFile` has no per-file target on a Markdown
    // document, so navigating to it can never focus anything in the diff.
    await mount.getByRole('button', { name: 'Add file comment' }).click();
    await composer.fill('This whole file needs a table of contents.');
    await composerPanel.getByRole('button', { name: 'Save', exact: true }).click();
    const fileItem = mount.locator('.diff-review-comment-item').filter({
      hasText: 'This whole file needs a table of contents.',
    });
    await expect(fileItem).toHaveAttribute('data-anchor-status', 'current');
    const unavailableStatus = mount.locator('.diff-review-navigation-unavailable[role="status"]');
    await expect(unavailableStatus).toHaveCount(0);
    await fileItem.getByRole('button', { name: 'Go to' }).click();
    await expect(unavailableStatus).toHaveCount(1);
    await expect(unavailableStatus).toHaveText(
      "That comment's location isn't available in the current view.",
    );

    // "Go to" on the CURRENT line comment focuses its live control.
    const lineItem = mount
      .locator('.diff-review-comment-item')
      .filter({ hasText: 'This should mention the CLI too.' });
    await lineItem.getByRole('button', { name: 'Go to' }).click();
    await expect(control).toBeFocused();
    // The unavailable status from the earlier file-level navigation is
    // cleared by a subsequent successful navigation, not left stuck on.
    await expect(unavailableStatus).toHaveCount(0);

    // -- Content changes: the line comment becomes OUTDATED (target lives) --
    await mount.getByRole('button', { name: 'Change content' }).click();
    await expect(lineItem).toHaveAttribute('data-anchor-status', 'outdated');
    await expect(lineItem.locator('.diff-review-comment-item-badge-outdated')).toHaveText(
      'Outdated',
    );

    await lineItem.getByRole('button', { name: 'Go to' }).click();
    // Focus lands on the item's own captured-detail text, scoped to it...
    const capturedDetail = lineItem.locator('.diff-review-comment-item-captured-detail');
    await expect(capturedDetail).toBeFocused();
    // ...and NEVER on a diff annotation control anywhere in the mount --
    // the explicit negative assertion the contract's "never focus a current
    // row" rule requires for an outdated comment.
    await expect(mount.locator(':focus[data-cinder-annotation-control]')).toHaveCount(0);

    // -- The target is removed entirely: status becomes REMOVED -------------
    await mount.getByRole('button', { name: 'Remove target' }).click();
    await expect(lineItem).toHaveAttribute('data-anchor-status', 'removed');
    await expect(lineItem.locator('.diff-review-comment-item-badge-outdated')).toHaveText(
      'Removed',
    );
    await expect(mount.locator('.diff-review-file-list-item')).toHaveCount(0);
    await expect(mount.locator('.diff-review-renderer-empty')).toHaveText('No file selected.');

    await lineItem.getByRole('button', { name: 'Go to' }).click();
    await expect(lineItem.locator('.diff-review-comment-item-captured-detail')).toBeFocused();
    await expect(mount.locator(':focus[data-cinder-annotation-control]')).toHaveCount(0);

    // The removed target's comment is still fully retained, editable, and
    // exportable -- captured context, not silently dropped.
    await expect(lineItem).toBeVisible();
    await expect(mount.getByText('Copy review')).toBeVisible();
  });
});
