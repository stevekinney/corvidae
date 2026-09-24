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

/** Forces both the modern Clipboard API and the legacy execCommand fallback to fail. */
async function breakClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    document.execCommand = () => false;
  });
}

test.describe('Diff review — fixture scenarios', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('renders the Markdown pair, multi-file source, mixed-target, and standalone mounts', async ({
    page,
  }) => {
    await expect(page.locator('#example-mount-markdown-pair')).toBeVisible();
    await expect(page.locator('#example-mount-multi-file-source')).toBeVisible();
    await expect(page.locator('#example-mount-mixed-target')).toBeVisible();
    await expect(page.locator('#example-mount-standalone-diff-viewer')).toBeVisible();
    await expect(page.locator('#example-mount-standalone-source-diff-viewer')).toBeVisible();

    // The multi-file source patch lists both files in its file navigation.
    const files = page.locator('#example-mount-multi-file-source .diff-review-file-list-path');
    await expect(files).toHaveText(['src/one.ts', 'src/two.ts']);
  });

  test('the path filter narrows the multi-file source patch file list', async ({ page }) => {
    const mount = page.locator('#example-mount-multi-file-source');
    await mount.getByLabel('Filter files by path').fill('two');
    await expect(mount.locator('.diff-review-file-list-item')).toHaveCount(1);
    await expect(mount.locator('.diff-review-file-list-path')).toHaveText('src/two.ts');
  });
});

test.describe('Diff review — comment creation', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('selecting a changed line, typing feedback, and saving creates a real comment', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-markdown-pair');
    // The fixture's Markdown pair changes exactly one line; its "new" side
    // annotation control is DiffViewer's own real add-comment control (see
    // diff-viewer-annotation.playwright.ts), not anything DiffReview adds.
    const control = mount
      .locator('[data-cinder-annotation-control][data-cinder-side="new"]')
      .first();
    await control.click();

    const composer = mount.getByLabel('Comment', { exact: true });
    await expect(composer).toBeVisible();
    await composer.fill('Please tighten this sentence.');
    await mount.getByText('Save', { exact: true }).click();

    // The composer closes and the new comment is visible in the panel.
    await expect(mount.getByLabel('Comment', { exact: true })).toHaveCount(0);
    await expect(mount.locator('.diff-review-comment-item')).toContainText(
      'Please tighten this sentence.',
    );
    // The file list's comment count reflects the real saved comment.
    await expect(mount.locator('.diff-review-file-list-counts')).toContainText('1 comment');
  });
});

test.describe('Diff review — Markdown/JSON downloads', () => {
  test.beforeEach(async ({ page }) => {
    await goto(page);
  });

  test('Download Markdown produces review.md with the complete review content', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-markdown-pair');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      mount.getByText('Download Markdown').click(),
    ]);
    expect(download.suggestedFilename()).toBe('review.md');
    const path = await download.path();
    expect(path).not.toBeNull();
    const bytes = await Bun.file(path).text();
    expect(bytes).toContain('# Review feedback');
    expect(bytes.endsWith('\n')).toBe(true);
  });

  test('Download JSON produces review.json with schemaVersion 1 and no BOM', async ({ page }) => {
    const mount = page.locator('#example-mount-markdown-pair');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      mount.getByText('Download JSON').click(),
    ]);
    expect(download.suggestedFilename()).toBe('review.json');
    const path = await download.path();
    expect(path).not.toBeNull();
    const raw = await Bun.file(path).arrayBuffer();
    const bytes = new Uint8Array(raw);
    expect(bytes[0]).not.toBe(0xef); // no UTF-8 BOM
    const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(1);
  });
});

test.describe('Diff review — clipboard copy', () => {
  test('Copy review announces success only, through a live region', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await goto(page);
    const mount = page.locator('#example-mount-markdown-pair');
    await mount.getByText('Copy review').click();
    await expect(mount.locator('.diff-review-toolbar [role="status"]')).toHaveText(
      'Copied review to clipboard.',
    );
    await expect(mount.locator('.diff-review-toolbar-error')).toHaveCount(0);
  });

  test('a clipboard failure is shown as visible, persistent text and leaves state intact', async ({
    page,
  }) => {
    await breakClipboard(page);
    await goto(page);
    const mount = page.locator('#example-mount-markdown-pair');
    await mount.getByText('Copy review').click();
    await expect(mount.getByRole('alert')).toContainText(
      'Unable to copy the review to the clipboard',
    );
    // Download still works after a clipboard failure.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      mount.getByText('Download Markdown').click(),
    ]);
    expect(download.suggestedFilename()).toBe('review.md');
  });
});
