import { loadManifest } from '@lostgradient/testing';
import { expect, test, type Page } from '@playwright/test';

const manifest = loadManifest();

function fixtureRoute(slug: string): string {
  const entry = manifest.find((candidate) => candidate.slug === slug);
  const hash = entry?.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined) throw new Error(`Assertion fixture hash missing for ${slug}.`);
  return `/page/${slug}?snapshot=1&fixture=assertion&fixtureContentHash=${hash}`;
}

async function goto(page: Page): Promise<void> {
  await page.goto(fixtureRoute('review-editor-diff-comments'), { waitUntil: 'load' });
  await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
}

/**
 * COR-512 / DR-7: `ReviewEditor`'s opt-in diff-review integration, exercised in a real browser.
 * `review-editor-diff-comments.test.ts` covers the state-layer contract (validation, latching,
 * aggregate export, navigation routing) under `bun:test`; this file covers exactly the part that
 * environment cannot -- switching to the diff tab, creating a real annotation-selected comment,
 * and switching tabs -- because `DiffViewer`'s composed shell cannot mount under the repository's
 * happy-dom harness (see that file's header and `diff-viewer.test.ts`'s).
 */
test.describe('Diff review — ReviewEditor integration', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('creating an old-side deletion comment in the diff tab, switching to the editor tab and back, the comment survives', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-diff-comments');
    await mount.getByRole('tab', { name: 'Diff' }).click();

    // The fixture's diff has no removed line by default (it only adds a line) -- exercise the
    // "old-side deletion" scenario by selecting the OLD side of a line that also exists on the
    // new side, which is still a real old-side annotation control on `DiffViewer`'s own rendered
    // unified diff (not anything this feature adds).
    const control = mount
      .locator('[data-cinder-annotation-control][data-cinder-side="old"]')
      .first();
    await expect(control).toBeVisible();
    await control.click();

    const composer = mount.getByLabel('Diff comment', { exact: true });
    await expect(composer).toBeVisible();
    await composer.fill('This line moves to the dashboard section.');
    await mount.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(mount.getByLabel('Diff comment', { exact: true })).toHaveCount(0);

    // Switch away to the editor tab and back to the diff tab.
    await mount.getByRole('tab', { name: 'Editor' }).click();
    await mount.getByRole('tab', { name: 'Diff' }).click();

    // The comment still exists: open the merged comments sidebar and find its row.
    const sidebarToggle = mount.getByRole('button', { name: /comments?/i }).first();
    await sidebarToggle.click();
    const diffRow = mount.locator('[data-anchor-kind="diff"]');
    await expect(diffRow).toHaveCount(1);
    await expect(diffRow).toContainText('This line moves to the dashboard section.');
    await expect(diffRow.locator('.diff-comment-kind-badge')).toHaveText('Diff · old');
  });

  test('the merged comments list distinguishes document and diff comments, and selecting each opens the matching tab', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-diff-comments');

    // Open the sidebar from the editor tab (the fixture seeds one document thread).
    const sidebarToggle = mount.getByRole('button', { name: /comments?/i }).first();
    await sidebarToggle.click();
    await expect(mount.locator('.thread-quote')).toBeVisible();

    // Create a diff comment first, from the diff tab.
    await mount.getByRole('tab', { name: 'Diff' }).click();
    const control = mount
      .locator('[data-cinder-annotation-control][data-cinder-side="new"]')
      .first();
    await control.click();
    await mount.getByLabel('Diff comment', { exact: true }).fill('New addition, looks correct.');
    await mount.getByRole('button', { name: 'Save', exact: true }).click();

    // Both a document row and a diff row now appear in the SAME comments list.
    await expect(mount.locator('.thread-quote')).toBeVisible();
    await expect(mount.locator('[data-anchor-kind="diff"]')).toHaveCount(1);

    // Selecting the current diff comment opens the diff tab in a mode that shows its side --
    // exercised from the editor tab, where the document thread's own "opens the editor tab as
    // today" behavior already leaves us.
    await mount.getByRole('tab', { name: 'Editor' }).click();
    await mount.locator('[data-diff-comment="true"]').click();
    await expect(mount.getByRole('tab', { name: 'Diff', selected: true })).toBeVisible();

    // Selecting a document comment uses its existing (pre-DR-7) editor-tab behavior, unchanged:
    // it opens that thread's popover in place, without touching the diff tab this feature added.
    await mount.getByRole('tab', { name: 'Editor' }).click();
    await mount.locator('.thread-item', { hasText: 'Ship login' }).click();
    await expect(mount.locator('[id$="-thread-popover"]')).toBeVisible();
  });
});
