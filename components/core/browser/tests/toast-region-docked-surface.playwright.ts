/// <reference lib="dom" />
/**
 * COR-2327: a surface the page docks to the bottom itself (a chat's composer, with a reminder row
 * above it) marks itself with Cinder's `dockedToBottom()` attachment, so a toast sits above it at
 * every width: on a phone with the tab bar under it, and on a wide screen with nothing under it.
 * Measured on the `toast-region` fixture with `?docked-surface=1`, which leaves the default
 * fixture's baselines alone. The boxes are read in one pass, once the toast has finished arriving.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Page } from '@playwright/test';

type Box = { top: number; bottom: number; left: number; right: number };

function intersects(first: Box, second: Box): boolean {
  return (
    first.left < second.right &&
    second.left < first.right &&
    first.top < second.bottom &&
    second.top < first.bottom
  );
}

/** Shows a toast that stays, waits for it to finish arriving, and reads the boxes. */
async function showToastAndRead(page: Page) {
  await page.getByRole('button', { name: 'Dismiss-after-action' }).click();
  const toast = page.locator('.cinder-toast', { hasText: 'Item moved to trash.' });
  await expect(toast).toBeVisible();
  await toast.evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    return {
      surface: box('[data-testid="docked-surface"]'),
      navigation: box('[data-testid="bottom-tab-bar"] nav.cinder-navigation-bar'),
      toast: box('.cinder-toast'),
    };
  });
}

test('at 375px a toast sits above a docked surface stacked on the bottom navigation bar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${fixtureRoute('toast-region')}&docked-surface=1&bottom-tab-bar=1`, {
    waitUntil: 'load',
  });
  await page.locator('[data-testid="docked-surface"]').waitFor({ state: 'visible' });
  await page.locator('[data-testid="bottom-tab-bar"] nav.cinder-navigation-bar').waitFor();

  const read = await showToastAndRead(page);
  const surface = read.surface!;
  const navigation = read.navigation!;
  const toast = read.toast!;
  expect(navigation.bottom).toBeGreaterThan(800);
  expect(Math.abs(surface.bottom - navigation.top)).toBeLessThan(1);
  expect(toast.bottom).toBeLessThanOrEqual(surface.top);
  expect(intersects(toast, surface)).toBe(false);
  expect(intersects(toast, navigation)).toBe(false);
});

test('at 1280px a toast sits above a docked surface with nothing under it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${fixtureRoute('toast-region')}&docked-surface=1`, { waitUntil: 'load' });
  await page.locator('[data-testid="docked-surface"]').waitFor({ state: 'visible' });

  const read = await showToastAndRead(page);
  const surface = read.surface!;
  const toast = read.toast!;
  expect(surface.bottom).toBeGreaterThan(799);
  expect(toast.bottom).toBeLessThanOrEqual(surface.top);
  expect(intersects(toast, surface)).toBe(false);
});
