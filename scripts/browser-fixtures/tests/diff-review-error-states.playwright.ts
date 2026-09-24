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
 * COR-511 / DR-8: the empty, binary, truncated, invalid-target, and
 * mid-session-stale review states inside `DiffReview` itself, none of which
 * any prior DR-6/DR-7 browser fixture exercised at this component's own
 * level (only at the standalone `DiffViewer`/`SourceDiffViewer` level, or
 * only under `bun:test`/happy-dom for invalid targets).
 *
 * VoiceOver was not driven in this session; every "announced" claim below is
 * a DOM/live-region assertion (an exact `role="status"`/`role="alert"` node
 * count and text), not a screen-reader transcript.
 */
test.describe('Diff review — empty and no-commentable-lines states', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('a session with no targets shows "No file selected." and still exports', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-empty');
    await expect(mount.locator('.diff-review-renderer-empty')).toHaveText('No file selected.');
    await expect(mount.locator('.diff-review-file-list-item')).toHaveCount(0);
    await expect(mount.getByText('Copy review')).toBeVisible();
    await expect(mount.getByText('Download Markdown')).toBeEnabled();
  });

  test('a file with no changed lines shows "No commentable patch lines." and keeps file-level comments available', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-no-change');
    await expect(mount.locator('.diff-review-renderer-empty')).toHaveText(
      'No commentable patch lines.',
    );
    await expect(mount.getByLabel('Filter files by path')).toBeVisible();
    await expect(mount.getByRole('button', { name: 'Add file comment' })).toBeEnabled();
  });
});

test.describe('Diff review — binary file state', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('a binary file has zero changed lines, no annotation controls, and still permits a file-level comment', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-binary');
    await mount.locator('.diff-review-file-list-button').click();
    await expect(mount.locator('.diff-review-file-list-counts')).toContainText('0 changed');
    await expect(mount.locator('[data-cinder-annotation-control]')).toHaveCount(0);

    const addFileComment = mount.getByRole('button', { name: 'Add file comment' });
    await expect(addFileComment).toBeEnabled();
    await addFileComment.click();
    await mount.getByLabel('Comment', { exact: true }).fill('Please describe this asset change.');
    await mount
      .locator('.diff-review-composer')
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(mount.locator('.diff-review-comment-item')).toContainText(
      'Please describe this asset change.',
    );
  });
});

test.describe('Diff review — truncated patch state', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test("SourceDiffViewer's own truncation notice surfaces inside DiffReview, and rendered rows remain commentable", async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-truncated');
    await mount.locator('.diff-review-file-list-button').click();

    const notice = mount.locator('[role="status"]', {
      hasText: /Showing first \d+ of \d+ diff lines\./,
    });
    await expect(notice).toHaveCount(1);

    const control = mount.locator('[data-cinder-annotation-control]').first();
    await expect(control).toBeVisible();
    await control.click();
    await expect(mount.getByLabel('Comment', { exact: true })).toBeVisible();
  });
});

test.describe('Diff review — invalid-target update', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('an invalid targets update shows exactly one alert and keeps the last valid view, until corrected', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-invalid-toggle');
    const alert = mount.locator('.diff-review-targets-error[role="alert"]');
    await expect(alert).toHaveCount(0);
    await expect(mount.getByText('toggle.md')).toBeVisible();

    await mount.getByRole('button', { name: 'Break targets' }).click();
    await expect(alert).toHaveCount(1);
    await expect(alert).toContainText('invalid-target');
    // The last valid file list is retained, not wiped by the bad update.
    await expect(mount.getByText('toggle.md')).toBeVisible();

    await mount.getByRole('button', { name: 'Fix targets' }).click();
    await expect(alert).toHaveCount(0);
  });
});

test.describe('Diff review — mid-session staleness', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('going stale disables line creation but keeps file comments, existing comments, and export available; recompute re-enables it', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-stale');
    const control = mount.locator(
      '[data-cinder-annotation-control][data-cinder-side="new"][data-cinder-line="2"]',
    );

    await control.click();
    await mount.getByLabel('Comment', { exact: true }).fill('Saved before staleness.');
    await mount
      .locator('.diff-review-composer')
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(mount.locator('.diff-review-comment-item')).toContainText(
      'Saved before staleness.',
    );

    await mount.getByRole('button', { name: 'Make document large' }).click();
    await expect(control).toBeDisabled();
    await expect(mount).toContainText(
      'The diff is outdated. Recompute it to add a new comment; existing comments remain available.',
    );
    // Existing saved comment and file-level creation remain available.
    await expect(mount.locator('.diff-review-comment-item')).toContainText(
      'Saved before staleness.',
    );
    await expect(mount.getByRole('button', { name: 'Add file comment' })).toBeEnabled();
    await expect(mount.getByText('Copy review')).toBeVisible();

    await mount.getByRole('button', { name: 'Compute Diff' }).click();
    await expect(control).toBeEnabled({ timeout: 10_000 });
  });
});
