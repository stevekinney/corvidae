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
    `#${mountId} [data-cinder-annotation-control][data-cinder-side="${side}"][data-cinder-line="${line}"]`,
  );
}

test.describe('Diff review — DiffViewer annotation hooks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(fixtureRoute('diff-viewer'), { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
  });

  test('clicking an added-side control commits a new-side selection', async ({ page }) => {
    const result = page.locator('#annotation-first-result');
    await expect(result).toHaveText('null');

    await control(page, 'example-mount-annotation-first', 'new', 3).click();

    await expect(result).toContainText('"side":"new"');
    await expect(result).toContainText('"startLine":3');
    await expect(result).toContainText('"endLine":3');
    await expect(result).toContainText('brand new');
  });

  test('a modified row exposes independent old and new selections', async ({ page }) => {
    const result = page.locator('#annotation-first-result');

    await control(page, 'example-mount-annotation-first', 'old', 2).click();
    await expect(result).toContainText('"side":"old"');
    await expect(result).toContainText('old middle');

    await control(page, 'example-mount-annotation-first', 'new', 2).click();
    await expect(result).toContainText('"side":"new"');
    await expect(result).toContainText('keep end');
  });

  test('an unchanged row is commentable on both sides', async ({ page }) => {
    const result = page.locator('#annotation-first-result');

    await control(page, 'example-mount-annotation-first', 'old', 1).click();
    await expect(result).toContainText('"startLine":1');
    await expect(result).toContainText('keep');

    await control(page, 'example-mount-annotation-first', 'new', 1).click();
    await expect(result).toContainText('"side":"new"');
  });

  test('keyboard Enter, Shift+ArrowDown, Enter commits a two-line same-side range', async ({
    page,
  }) => {
    const start = control(page, 'example-mount-annotation-first', 'old', 2);
    await start.focus();
    await page.keyboard.press('Enter');

    const result = page.locator('#annotation-first-result');
    // Starting a selection alone must not commit yet.
    await expect(result).toHaveText('null');

    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Enter');

    await expect(result).toContainText('"startLine":2');
    await expect(result).toContainText('"endLine":3');
    await expect(result).toContainText('old middle\\nkeep end');
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

  test('shift-clicking the other side is rejected without moving the origin', async ({ page }) => {
    await control(page, 'example-mount-annotation-first', 'old', 1).click();
    await control(page, 'example-mount-annotation-first', 'new', 2).click({ modifiers: ['Shift'] });

    const result = page.locator('#annotation-first-result');
    // The origin (old:1) is untouched -- the cross-side attempt did not commit.
    await expect(result).toContainText('"side":"old"');
    await expect(result).toContainText('"startLine":1');
    await expect(result).toContainText('"endLine":1');
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
    // The default mount is the only `.diff-viewer` rendered directly under
    // `#app`; the annotation-enabled mounts are each nested inside their own
    // wrapper div (`#example-mount-...`).
    const defaultMountControls = page.locator(
      '#app > .diff-viewer [data-cinder-annotation-control]',
    );
    await expect(defaultMountControls).toHaveCount(0);

    const enabledControls = page.locator(
      '#example-mount-annotation-first [data-cinder-annotation-control]',
    );
    await expect(enabledControls.first()).toBeVisible();
  });

  test('focusAnchor switches from final mode to unified to expose the old side, then focuses it', async ({
    page,
  }) => {
    const viewModeOutput = page.locator('#focus-anchor-view-mode');
    await expect(viewModeOutput).toHaveText('final');

    await page.getByRole('button', { name: 'Focus old line 2' }).click();

    await expect(viewModeOutput).toHaveText('unified');
    await expect(page.locator('#focus-anchor-result')).toContainText('"status":"focused"');

    const focused = control(page, 'example-mount-focus-anchor', 'old', 2);
    await expect(focused).toBeFocused();
  });
});
