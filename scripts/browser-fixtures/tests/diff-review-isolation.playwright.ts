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
 * COR-511 / DR-8: two-instance isolation at the `DiffReview`/
 * `DiffReviewComments` level. `diff-viewer-annotation.playwright.ts` and
 * `source-diff-viewer-annotation.playwright.ts` already prove this for the
 * underlying viewers' own annotation selection and control ids; this proves
 * it one level up, for comments, filters, and the review-note field several
 * independent `DiffReview`/`DiffReviewComments` mounts on the same page each
 * own.
 */
test.describe('Diff review — two-instance isolation', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('a saved comment, an unresolved-only filter toggle, and Review note text in one instance never affect another', async ({
    page,
  }) => {
    const first = page.locator('#example-mount-markdown-pair');
    const second = page.locator('#example-mount-readonly');
    const third = page.locator('#example-mount-standalone-diff-viewer');
    const fourth = page.locator('#example-mount-multi-file-source');

    // Sanity: none of the four instances has any comment yet.
    for (const mount of [first, second, third, fourth]) {
      await expect(mount.locator('.diff-review-comment-item')).toHaveCount(0);
    }

    // Save a real comment in the first instance only.
    await first.locator('[data-cinder-annotation-control][data-cinder-side="new"]').first().click();
    await first.getByLabel('Comment', { exact: true }).fill('Only in the first instance.');
    await first
      .locator('.diff-review-composer')
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(first.locator('.diff-review-comment-item')).toHaveCount(1);

    // It never appears in the other three, which share the same underlying
    // Markdown content (the readonly and standalone mounts) or are entirely
    // separate targets (the multi-file-source mount).
    for (const mount of [second, third, fourth]) {
      await expect(mount.locator('.diff-review-comment-item')).toHaveCount(0);
    }

    // Toggling "Unresolved only" in the first instance's comments panel does
    // not touch the second instance's own filter state.
    const firstUnresolved = first.getByRole('button', { name: 'Unresolved only', exact: true });
    const secondAll = second.getByRole('button', { name: 'All comments', exact: true });
    await expect(secondAll).toHaveAttribute('aria-pressed', 'true');
    await firstUnresolved.click();
    await expect(firstUnresolved).toHaveAttribute('aria-pressed', 'true');
    await expect(secondAll).toHaveAttribute('aria-pressed', 'true');

    // Each instance's Review note is a distinct, independently labelled
    // field: two instances never collide on the same id, and typing in one
    // never leaks into another.
    const firstNote = first.getByLabel('Review note');
    const secondNote = second.getByLabel('Review note');
    const firstNoteId = await firstNote.getAttribute('id');
    const secondNoteId = await secondNote.getAttribute('id');
    expect(firstNoteId).not.toBeNull();
    expect(secondNoteId).not.toBeNull();
    expect(firstNoteId).not.toBe(secondNoteId);

    await firstNote.fill('Note for the first instance only.');
    await firstNote.blur();
    await expect(secondNote).toHaveValue('');
  });
});
