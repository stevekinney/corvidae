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

    // The fixture's `original` has a bullet ("Ship the beta program") `initialValue` drops
    // entirely -- a genuine, isolated old-side DELETION, distinct from the old side of an
    // unchanged/context row (also selectable, per the contract's "unchanged text rows are also
    // commentable," but a different code path in `diff-line.svelte`: the `removed` branch, not
    // the `same` branch). Scope to the row that actually renders as removed so this cannot
    // silently degrade back to a context-row selection.
    const removedRow = mount.locator('.diff-row', { has: page.locator('.diff-line-removed') });
    const control = removedRow.locator('[data-cinder-annotation-control][data-cinder-side="old"]');
    await expect(control).toBeVisible();
    await control.click();

    const composer = mount.getByLabel('Diff comment', { exact: true });
    await expect(composer).toBeVisible();
    await composer.fill('This bullet moves to a different section.');
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
    await expect(diffRow).toContainText('This bullet moves to a different section.');
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

  test('navigating to a diff comment switches back from a mode that hides its side, and focuses its own control', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-diff-comments');
    await mount.getByRole('tab', { name: 'Diff' }).click();

    // Create an OLD-side comment on the genuinely removed line, and capture its side/line --
    // NOT its DOM id: `DiffViewer` scopes every control id to a per-mount `instanceId` (DR-3/DR-4,
    // "scoped instance IDs"), and navigating away from the diff tab destroys this component
    // entirely (an `{:else if}` branch, not a hide), so the id a fresh remount assigns the SAME
    // logical control is deliberately a different string. Side/line identify the anchor itself.
    const removedRow = mount.locator('.diff-row', { has: page.locator('.diff-line-removed') });
    const control = removedRow.locator('[data-cinder-annotation-control][data-cinder-side="old"]');
    await expect(control).toBeVisible();
    const anchorLine = await control.getAttribute('data-cinder-line');
    if (!anchorLine) throw new Error('Expected the annotation control to carry its line number.');
    await control.click();
    await mount.getByLabel('Diff comment', { exact: true }).fill('This bullet moves elsewhere.');
    await mount.getByRole('button', { name: 'Save', exact: true }).click();

    // Switch to Final mode, which hides every old-only (removed) row entirely -- the comment's
    // own anchor is no longer visible in the diff at all, so navigating back to it MUST switch
    // the mode, not just the tab (contract, `DiffViewerRef.focusAnchor`: "a `final`-mode viewer
    // switches to `unified` to expose an `old`-side anchor").
    const diffModeControls = mount.locator('.controls-diff-mode-inline');
    await diffModeControls.getByRole('radio', { name: 'Final' }).click();
    await expect(mount.locator('.diff-line-removed')).toHaveCount(0);

    // Navigate away, open the merged list from the editor tab, and select the diff comment.
    await mount.getByRole('tab', { name: 'Editor' }).click();
    const sidebarToggle = mount.getByRole('button', { name: /comments?/i }).first();
    await sidebarToggle.click();
    await mount.locator('[data-diff-comment="true"]').click();

    // The diff tab is selected, in a mode that exposes the old side again, AND focus actually
    // lands on that comment's own control -- proving `focusAnchor` ran, not merely that the tab
    // switched (a mount-time flush could leave `bind:ref` unpopulated and this would silently
    // never fire; only asserting real focus catches that). Matched by side + line, since the
    // freshly remounted `DiffViewer` assigns its controls a new `instanceId` prefix.
    await expect(mount.getByRole('tab', { name: 'Diff', selected: true })).toBeVisible();
    await expect(
      diffModeControls.getByRole('radio', { name: 'Unified', checked: true }),
    ).toBeVisible();
    const focused = page.locator('[data-cinder-annotation-control]:focus');
    await expect(focused).toHaveAttribute('data-cinder-side', 'old');
    await expect(focused).toHaveAttribute('data-cinder-line', anchorLine);
  });

  test('cancelling the composer preserves the draft in the Unsaved drafts inventory, and Discard removes it', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-diff-comments');
    await mount.getByRole('tab', { name: 'Diff' }).click();

    const removedRow = mount.locator('.diff-row', { has: page.locator('.diff-line-removed') });
    const control = removedRow.locator('[data-cinder-annotation-control][data-cinder-side="old"]');
    await expect(control).toBeVisible();
    await control.click();

    // Type a nonempty body, then CANCEL rather than Save. Contract: "Cancel preserves an existing
    // draft; only the explicitly confirmed discard action deletes nonempty text." Cancelling
    // closes the composer but must not silently drop the text.
    await mount.getByLabel('Diff comment', { exact: true }).fill('Half-written thought.');
    await mount.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(mount.getByLabel('Diff comment', { exact: true })).toHaveCount(0);

    // The draft survives, visible and recoverable in the persistent "Unsaved drafts" inventory --
    // not merely present in state with no way back to it.
    const inventory = mount.getByRole('region', { name: 'Unsaved drafts' });
    await expect(inventory).toBeVisible();
    await expect(inventory).toContainText('Half-written thought.');

    // Discard actually removes it.
    await inventory.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(mount.getByRole('region', { name: 'Unsaved drafts' })).toHaveCount(0);
  });

  test("Open on a pending draft focuses the reopened composer (COR-511 review, mirrors DiffReview's own fix)", async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-diff-comments');
    await mount.getByRole('tab', { name: 'Diff' }).click();

    const removedRow = mount.locator('.diff-row', { has: page.locator('.diff-line-removed') });
    const control = removedRow.locator('[data-cinder-annotation-control][data-cinder-side="old"]');
    await control.click();
    await mount.getByLabel('Diff comment', { exact: true }).fill('Reopen me later.');
    await mount.getByRole('button', { name: 'Cancel', exact: true }).click();

    const inventory = mount.getByRole('region', { name: 'Unsaved drafts' });
    await inventory.getByRole('button', { name: 'Open', exact: true }).click();

    await expect(mount.getByLabel('Diff comment', { exact: true })).toBeFocused();
  });

  test('opening a pending draft while read-only renders a disabled composer with an explanatory note', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-diff-comments');
    await mount.getByRole('tab', { name: 'Diff' }).click();

    // Create a draft and cancel, exactly as above, leaving it recoverable in the inventory.
    const removedRow = mount.locator('.diff-row', { has: page.locator('.diff-line-removed') });
    const control = removedRow.locator('[data-cinder-annotation-control][data-cinder-side="old"]');
    await expect(control).toBeVisible();
    await control.click();
    await mount.getByLabel('Diff comment', { exact: true }).fill('Half-written thought.');
    await mount.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Switch the host to read-only, THEN open the now-orphaned draft from the inventory. Before
    // this fix, `activeDiffDraftId` could only ever be set from `onAnnotationSelectionChange`
    // (never wired while read-only), so this composer state was previously unreachable there --
    // the drafts inventory's "Open" action (COR-512 / DR-7 review follow-up) makes it reachable,
    // and it must render fully disabled rather than live.
    await mount.locator('#toggle-readonly').click();
    const inventory = mount.getByRole('region', { name: 'Unsaved drafts' });
    await inventory.getByRole('button', { name: 'Open', exact: true }).click();

    const composer = mount.getByLabel('Diff comment', { exact: true });
    await expect(composer).toBeVisible();
    // Not `disabled` (COR-511 review, mirrors the identical fix in
    // `diff-review.svelte`): a `disabled` textarea can never receive focus
    // in a real browser, which would silently break "Open ... focuses its
    // composer" (contract, no stated read-only exception) for exactly this
    // case. Native `readonly` blocks editing identically while keeping the
    // element focusable and its text selectable/copyable.
    await expect(composer).not.toBeEditable();
    await expect(mount.getByText('Enable editing to change or save this draft.')).toBeVisible();
    const saveButton = mount.getByRole('button', { name: 'Save', exact: true });
    await expect(saveButton).toBeDisabled();
    await expect(composer).toBeFocused();
  });
});
