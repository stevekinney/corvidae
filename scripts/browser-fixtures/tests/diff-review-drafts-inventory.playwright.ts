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
  await page.goto(fixtureRoute('diff-review'), { waitUntil: 'load' });
  await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
}

/**
 * COR-511 / DR-8: the "Unsaved drafts" hidden-draft inventory, exercised
 * across two different hiding mechanisms in the same session -- a draft on a
 * target that is no longer the one displayed in the diff pane, and a draft
 * whose file entry the path filter has hidden from the file navigation list.
 * Neither prior DR-6/DR-7 issue's browser fixtures exercised the inventory
 * with more than one nonempty draft at once, or proved the export gate's
 * `role="status"` announcement text changes -- exactly once per state -- as
 * drafts are saved and discarded.
 *
 * VoiceOver was not driven in this session; the "announced once" claim below
 * is verified by asserting the live `[role="status"]` node's count and exact
 * text at each transition, not by a screen reader.
 */
test.describe('Diff review — hidden-draft inventory', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('drafts hidden by target selection and by the path filter still block export, and Open/Save/Discard resolve them', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-mixed-target');
    const gate = mount.locator('.diff-review-toolbar-gate[role="status"]');

    // No drafts yet: the gate is absent and export controls are live.
    await expect(gate).toHaveCount(0);
    await expect(mount.getByText('Copy review')).toBeVisible();

    // -- Draft 1: on the initially-selected Markdown target (readme-mixed) --
    await mount
      .locator('[data-cinder-annotation-control][data-cinder-side="new"][data-cinder-line="1"]')
      .click();
    const composer = mount.getByLabel('Comment', { exact: true });
    const composerPanel = mount.locator('.diff-review-composer');
    await expect(composer).toBeVisible();
    await composer.fill('First hidden draft (readme-mixed).');
    // Cancel closes the composer but -- per the contract's "Cancel preserves
    // an existing draft" -- must not discard the nonempty text just typed.
    await composerPanel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(composer).toHaveCount(0);

    // One nonempty draft already blocks export, with the singular count.
    await expect(gate).toHaveCount(1);
    await expect(gate).toHaveText(
      '1 unsaved draft must be saved or discarded before export. Review drafts',
    );
    await expect(mount.getByText('Copy review')).toHaveCount(0);

    // -- Switch to the other target's file (patch-mixed / package.json) --
    // The diff pane now shows a different target entirely: draft 1's own
    // location is no longer visible anywhere in the current view.
    await mount.locator('.diff-review-file-list-button', { hasText: 'package.json' }).click();
    await expect(mount.locator('.diff-review-comment-item')).toHaveCount(0); // sanity: no saved comments yet

    // -- Draft 2: on the now-active source target (patch-mixed) --
    await mount
      .locator(
        '[data-cinder-annotation-control][data-cinder-file-occurrence="0"]' +
          '[data-cinder-hunk-occurrence="0"][data-cinder-side="new"][data-cinder-line="1"]',
      )
      .click();
    await expect(composer).toBeVisible();
    await composer.fill('Second hidden draft (patch-mixed).');
    await composerPanel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(composer).toHaveCount(0);

    // -- Hide every file entry from the nav list with the path filter -----
    await mount.getByLabel('Filter files by path').fill('zzz-no-match');
    await expect(mount.locator('.diff-review-file-list-item')).toHaveCount(0);

    // Both drafts still block export, with the plural count -- the gate is
    // exactly one live node with exactly this text (never duplicated).
    await expect(gate).toHaveCount(1);
    await expect(gate).toHaveText(
      '2 unsaved drafts must be saved or discarded before export. Review drafts',
    );
    await expect(mount.getByText('Copy review')).toHaveCount(0);
    await expect(mount.getByText('Download Markdown')).toHaveCount(0);
    await expect(mount.getByText('Download JSON')).toHaveCount(0);

    // -- Open the inventory: both drafts are listed regardless of the       --
    // -- current target selection or the active path filter.               --
    await gate.getByRole('button', { name: 'Review drafts' }).click();
    const inventory = mount.getByRole('region', { name: 'Unsaved drafts' });
    await expect(inventory).toBeVisible();
    await expect(inventory.locator('.diff-review-drafts-inventory-item')).toHaveCount(2);
    const firstItem = inventory
      .locator('.diff-review-drafts-inventory-item')
      .filter({ hasText: 'First hidden draft (readme-mixed).' });
    const secondItem = inventory
      .locator('.diff-review-drafts-inventory-item')
      .filter({ hasText: 'Second hidden draft (patch-mixed).' });
    await expect(firstItem).toHaveCount(1);
    await expect(secondItem).toHaveCount(1);

    // -- Open the hidden (not currently displayed) first draft: it switches --
    // -- the diff pane back to its own target and reopens its composer.    --
    await firstItem.getByRole('button', { name: 'Open' }).click();
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue('First hidden draft (readme-mixed).');
    await expect(
      mount.locator(
        '[data-cinder-annotation-control][data-cinder-side="new"][data-cinder-line="1"]',
      ),
    ).toBeVisible();

    // -- Save it: the gate drops back to the singular count. ----------------
    await composerPanel.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(gate).toHaveCount(1);
    await expect(gate).toHaveText(
      '1 unsaved draft must be saved or discarded before export. Review drafts',
    );

    // -- Discard the remaining draft: export is fully restored. -------------
    await inventory.getByRole('button', { name: 'Discard' }).click();
    await expect(gate).toHaveCount(0);
    await expect(inventory).toHaveCount(0);
    await expect(mount.getByText('Copy review')).toBeVisible();
    await expect(mount.getByText('Download Markdown')).toBeVisible();
    await expect(mount.getByText('Download JSON')).toBeVisible();

    // The saved draft became a real, current comment.
    await expect(mount.locator('.diff-review-comment-item')).toContainText(
      'First hidden draft (readme-mixed).',
    );
  });
});
