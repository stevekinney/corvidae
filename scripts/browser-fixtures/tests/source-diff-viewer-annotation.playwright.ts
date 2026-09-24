import { loadManifest } from '@lostgradient/testing';
import { expect, test, type Locator, type Page } from '@playwright/test';

const manifest = loadManifest();

function fixtureRoute(slug: string): string {
  const entry = manifest.find((candidate) => candidate.slug === slug);
  const hash = entry?.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined) throw new Error(`Assertion fixture hash missing for ${slug}.`);
  return `/page/${slug}?snapshot=1&fixture=assertion&fixtureContentHash=${hash}`;
}

function control(page: Page, mountId: string, side: 'old' | 'new', line: number): Locator {
  return page.locator(
    `#${mountId} [data-cinder-annotation-control][data-cinder-file-occurrence="0"]` +
      `[data-cinder-hunk-occurrence="0"][data-cinder-side="${side}"][data-cinder-line="${line}"]`,
  );
}

test.describe('Diff review — SourceDiffViewer annotation hooks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(fixtureRoute('source-diff-viewer'), { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
  });

  test('clicking an addition control commits a new-side selection', async ({ page }) => {
    const result = page.locator('#annotation-first-result');
    await expect(result).toHaveText('null');

    await control(page, 'example-mount-annotation-first', 'new', 2).click();

    await expect(result).toContainText('"side":"new"');
    await expect(result).toContainText('"startLine":2');
    await expect(result).toContainText('"endLine":2');
    await expect(result).toContainText('normalizedName');
  });

  test('keyboard Enter, Shift+ArrowDown, Enter commits a two-line range', async ({ page }) => {
    const start = control(page, 'example-mount-annotation-first', 'new', 2);
    await start.focus();
    await page.keyboard.press('Enter');

    const result = page.locator('#annotation-first-result');
    // Starting a selection alone must not commit yet.
    await expect(result).toHaveText('null');

    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Enter');

    await expect(result).toContainText('"startLine":2');
    await expect(result).toContainText('"endLine":3');
  });

  test('Escape cancels a pending keyboard selection and returns focus to its origin', async ({
    page,
  }) => {
    const start = control(page, 'example-mount-annotation-first', 'new', 1);
    await start.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Escape');

    await expect(start).toBeFocused();
    await expect(page.locator('#annotation-first-result')).toHaveText('null');
  });

  test('shift-click extends from the last selection origin', async ({ page }) => {
    await control(page, 'example-mount-annotation-first', 'new', 1).click();
    await control(page, 'example-mount-annotation-first', 'new', 3).click({ modifiers: ['Shift'] });

    const result = page.locator('#annotation-first-result');
    await expect(result).toContainText('"startLine":1');
    await expect(result).toContainText('"endLine":3');
  });

  test('an annotation selection in one instance never affects a second instance', async ({
    page,
  }) => {
    await control(page, 'example-mount-annotation-first', 'new', 2).click();

    await expect(page.locator('#annotation-first-result')).not.toHaveText('null');
    await expect(page.locator('#annotation-second-result')).toHaveText('null');
  });

  test('the two instances never share a control id', async ({ page }) => {
    const firstIds = await page
      .locator('#example-mount-annotation-first [data-cinder-annotation-control]')
      .evaluateAll((elements) => elements.map((element) => element.id));
    const secondIds = await page
      .locator('#example-mount-annotation-second [data-cinder-annotation-control]')
      .evaluateAll((elements) => elements.map((element) => element.id));

    expect(firstIds.length).toBeGreaterThan(0);
    for (const id of firstIds) expect(secondIds).not.toContain(id);
  });

  test('the default (no annotation props) instance renders no annotation controls', async ({
    page,
  }) => {
    const controls = page.locator('#example-mount-default [data-cinder-annotation-control]');
    await expect(controls).toHaveCount(0);
  });
});
