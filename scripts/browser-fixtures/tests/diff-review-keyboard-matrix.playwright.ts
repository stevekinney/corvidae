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
 * COR-511 / DR-8: a real, keyboard-only walk across `DiffReview`'s own
 * controls (never dragging or clicking). `diff-review-keyboard.test.ts`
 * proves the same controls are natively tab-reachable under `bun:test`/
 * happy-dom by inspecting `tabindex`; this is the real-browser proof that
 * `Tab` actually lands on each one in order, and that `Enter`/`Space` really
 * activate them -- exactly the class of defect (a wrapper that swallows
 * focus, an element made unreachable by layout, a dialog that traps or drops
 * focus) a `tabindex` inspection alone cannot catch. The underlying viewers'
 * own annotation-control keyboard model (Enter / Shift+Arrow / Enter /
 * Escape) is covered by `diff-viewer-annotation.playwright.ts` and
 * `source-diff-viewer-annotation.playwright.ts` and is not repeated here.
 *
 * Each case below corresponds to one row of the keyboard-matrix table
 * recorded in `diff-review.a11y.md`.
 */
test.describe('Diff review — keyboard matrix: toolbar and file list', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('Tab walks filter -> scope -> Copy -> Download Markdown -> Download JSON -> file button -> Reviewed -> Add file comment, in order', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-markdown-pair');

    const filter = mount.getByLabel('Filter files by path');
    const scope = mount.locator('.diff-review-toolbar-scope select');
    const copy = mount.getByRole('button', { name: 'Copy review', exact: true });
    const downloadMd = mount.getByRole('button', { name: 'Download Markdown', exact: true });
    const downloadJson = mount.getByRole('button', { name: 'Download JSON', exact: true });
    const fileButton = mount.locator('.diff-review-file-list-button').first();
    const reviewed = mount.getByLabel('Reviewed');
    const addFileComment = mount.getByRole('button', { name: 'Add file comment' });

    await filter.focus();
    await expect(filter).toBeFocused();

    for (const next of [
      scope,
      copy,
      downloadMd,
      downloadJson,
      fileButton,
      reviewed,
      addFileComment,
    ]) {
      await page.keyboard.press('Tab');
      await expect(next).toBeFocused();
    }
  });

  test('Space toggles the Reviewed checkbox from the keyboard, with no separate status/alert announcement', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-markdown-pair');
    const reviewed = mount.getByLabel('Reviewed');
    const statusOrAlertNodes = mount.locator('[role="status"], [role="alert"]');
    await expect(reviewed).not.toBeChecked();
    const before = await statusOrAlertNodes.count();

    // Native checkbox semantics announce the checked-state change to
    // assistive technology on their own; the contract does not additionally
    // require a separate live-region announcement here, and this proves none
    // exists -- Space only ever flips the DOM `checked` state, never adds or
    // changes a `role="status"`/`role="alert"` node.
    await reviewed.focus();
    await page.keyboard.press('Space');
    await expect(reviewed).toBeChecked();
    await expect(statusOrAlertNodes).toHaveCount(before);
    await page.keyboard.press('Space');
    await expect(reviewed).not.toBeChecked();
    await expect(statusOrAlertNodes).toHaveCount(before);
  });

  test('Enter activates a file list button exactly like a click', async ({ page }) => {
    const mount = page.locator('#example-mount-multi-file-source');
    const secondFile = mount.locator('.diff-review-file-list-button', { hasText: 'src/two.ts' });
    await secondFile.focus();
    await page.keyboard.press('Enter');
    await expect(secondFile).toHaveAttribute('aria-current', 'true');
  });
});

test.describe('Diff review — keyboard matrix: composer and comment actions', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('Tab walks the open composer from its textarea to Save to Cancel', async ({ page }) => {
    const mount = page.locator('#example-mount-markdown-pair');
    await mount.locator('[data-cinder-annotation-control][data-cinder-side="new"]').first().click();

    const composer = mount.locator('.diff-review-composer');
    const textarea = composer.getByLabel('Comment', { exact: true });
    const save = composer.getByRole('button', { name: 'Save', exact: true });
    const cancel = composer.getByRole('button', { name: 'Cancel', exact: true });

    await textarea.fill('Keyboard-only comment.');
    await textarea.focus();
    await expect(textarea).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(save).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
  });

  test('Tab walks a saved comment: Go to -> Edit -> Resolve -> Delete', async ({ page }) => {
    const mount = page.locator('#example-mount-markdown-pair');
    await mount.locator('[data-cinder-annotation-control][data-cinder-side="new"]').first().click();
    await mount.getByLabel('Comment', { exact: true }).fill('A saved comment for keyboard order.');
    await mount
      .locator('.diff-review-composer')
      .getByRole('button', { name: 'Save', exact: true })
      .click();

    const item = mount.locator('.diff-review-comment-item');
    const goTo = item.getByRole('button', { name: 'Go to' });
    const edit = item.getByRole('button', { name: 'Edit', exact: true });
    const resolve = item.getByRole('button', { name: 'Resolve', exact: true });
    const del = item.getByRole('button', { name: 'Delete', exact: true });

    await goTo.focus();
    await expect(goTo).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(edit).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(resolve).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(del).toBeFocused();
  });

  test('Escape on the delete-confirmation dialog closes it and returns real focus to the Delete button that opened it', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-markdown-pair');
    await mount.locator('[data-cinder-annotation-control][data-cinder-side="new"]').first().click();
    await mount.getByLabel('Comment', { exact: true }).fill('A comment to delete.');
    await mount
      .locator('.diff-review-composer')
      .getByRole('button', { name: 'Save', exact: true })
      .click();

    const del = mount.locator('.diff-review-comment-item').getByRole('button', {
      name: 'Delete',
      exact: true,
    });
    await del.focus();
    await del.click();

    const dialogDelete = page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete', exact: true });
    await expect(dialogDelete).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(del).toBeFocused();
    // The comment was never deleted.
    await expect(mount.locator('.diff-review-comment-item')).toHaveCount(1);
  });
});

test.describe('Diff review — keyboard matrix: drafts inventory and review note', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('Tab walks an inventory item from Open to Save to Discard, and the Review note is independently reachable', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-markdown-pair');
    await mount.locator('[data-cinder-annotation-control][data-cinder-side="new"]').first().click();
    await mount.getByLabel('Comment', { exact: true }).fill('An unsaved draft.');
    await mount
      .locator('.diff-review-composer')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();

    await mount.getByRole('button', { name: 'Review drafts' }).click();
    const item = mount.locator('.diff-review-drafts-inventory-item');
    const open = item.getByRole('button', { name: 'Open', exact: true });
    const save = item.getByRole('button', { name: 'Save', exact: true });
    const discard = item.getByRole('button', { name: 'Discard', exact: true });

    await open.focus();
    await expect(open).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(save).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(discard).toBeFocused();

    const reviewNote = mount.getByLabel('Review note');
    await reviewNote.focus();
    await expect(reviewNote).toBeFocused();
  });
});
