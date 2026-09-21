import { captureScreenshot, THEME_STORAGE_KEY, type Theme } from '@lostgradient/testing';
import { expect, test, type Page } from '@playwright/test';

import { fixtureRoute } from './overlay-fixture.ts';

const desktopViewport = { width: 1280, height: 720 };

async function openOverlayFixture(
  page: Page,
  slug: string,
  theme: Theme = 'light',
  fixtureName = 'assertion',
): Promise<void> {
  await page.setViewportSize(desktopViewport);
  await page
    .context()
    .addInitScript(([key, value]) => localStorage.setItem(key, value), [
      THEME_STORAGE_KEY,
      theme,
    ] as const);
  await page.goto(fixtureRoute(slug, { fixtureName }), { waitUntil: 'load' });
  await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
}

async function scrollFixtureTo(
  page: Page,
  coordinates: { top: number; left: number },
): Promise<void> {
  const scrollContainer = page.getByTestId('transformed-scroll-container');
  await scrollContainer.evaluate((element, nextCoordinates) => {
    element.scrollTo(nextCoordinates);
  }, coordinates);
  await expect
    .poll(async () =>
      scrollContainer.evaluate((element) => ({ top: element.scrollTop, left: element.scrollLeft })),
    )
    .toEqual(coordinates);
}

function expectVerticalPlacementGeometry(
  triggerBox: { x: number; y: number; width: number; height: number },
  overlayBox: { x: number; y: number; width: number; height: number },
  placement: string | null,
): void {
  expect(overlayBox.width).toBeGreaterThan(0);
  expect(overlayBox.height).toBeGreaterThan(0);
  expect(placement).toMatch(/^(bottom|top)/);
  const verticalGap = placement?.startsWith('top')
    ? triggerBox.y - (overlayBox.y + overlayBox.height)
    : overlayBox.y - (triggerBox.y + triggerBox.height);
  expect(verticalGap).toBeGreaterThanOrEqual(4);
  expect(verticalGap).toBeLessThanOrEqual(24);
  const triggerCenter = triggerBox.x + triggerBox.width / 2;
  expect(triggerCenter).toBeGreaterThanOrEqual(overlayBox.x - 16);
  expect(triggerCenter).toBeLessThanOrEqual(overlayBox.x + overlayBox.width + 16);
}

test('popover anchors inside transformed and scrolled preview shells', async ({ page }) => {
  await openOverlayFixture(page, 'popover');
  await scrollFixtureTo(page, { top: 120, left: 140 });
  const trigger = page.getByTestId('transformed-popover-trigger');
  await trigger.click();
  const panel = page.locator('.transformed-ancestor-popover-panel');
  await expect(panel).toHaveAttribute('data-cinder-position-ready', 'true');
  const triggerBox = await trigger.boundingBox();
  const overlayBox = await panel.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(overlayBox).not.toBeNull();
  expectVerticalPlacementGeometry(
    triggerBox!,
    overlayBox!,
    await panel.getAttribute('data-cinder-placement'),
  );
  await captureScreenshot(page, {
    slug: 'popover',
    theme: 'light',
    viewport: 'desktop',
    fixture: 'transformed-ancestor-shell',
  });
});

test('tooltip anchors inside transformed and scrolled preview shells', async ({ page }) => {
  await openOverlayFixture(page, 'tooltip');
  await scrollFixtureTo(page, { top: 120, left: 140 });
  const trigger = page.getByTestId('transformed-tooltip-trigger');
  await trigger.hover();
  const tooltip = page.getByRole('tooltip', { name: 'Transformed ancestor tooltip anchor' });
  await expect(tooltip).toHaveAttribute('data-cinder-position-ready', 'true');
  const triggerBox = await trigger.boundingBox();
  const overlayBox = await tooltip.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(overlayBox).not.toBeNull();
  expectVerticalPlacementGeometry(
    triggerBox!,
    overlayBox!,
    await tooltip.getAttribute('data-cinder-placement'),
  );
  await captureScreenshot(page, {
    slug: 'tooltip',
    theme: 'light',
    viewport: 'desktop',
    fixture: 'transformed-ancestor-shell',
  });
});

test('modal keeps a dialog-owned anchored overlay visible beyond its panel', async ({ page }) => {
  await openOverlayFixture(page, 'modal', 'light', 'anchored-overlay');
  const dialog = page.locator('dialog.cinder-modal');
  const panel = dialog.locator('.cinder-modal__panel');
  const overlay = dialog.locator('.cinder-popover').first();
  const scope = dialog.locator('.cinder-popover__portal-scope').first();
  await expect(dialog).toBeVisible();
  await expect(scope).toHaveCount(1);
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute('data-cinder-position-ready', 'true');
  const panelBox = await panel.boundingBox();
  const overlayBox = await overlay.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(overlayBox).not.toBeNull();
  expect(overlayBox!.y + overlayBox!.height).toBeGreaterThan(panelBox!.y + panelBox!.height);
  await expect
    .poll(() =>
      overlay.evaluate((element) => getComputedStyle(element.closest('dialog')!).overflow),
    )
    .toBe('visible');
});
