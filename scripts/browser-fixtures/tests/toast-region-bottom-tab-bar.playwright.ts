/// <reference lib="dom" />
/**
 * COR-2327: a bottom NavigationBar (a phone's tab bar) publishes its height as a docked action bar
 * does, so a toast that stays until it is dismissed sits above the tabs, not over them. Measured on
 * the `toast-region` assertion fixture with `?bottom-tab-bar=1`, which adds the bar without
 * touching the default fixture's baselines. With `?docked-stack=1` a docked action bar sits on the
 * tab bar, and the toast clears the top of the higher bar, not the taller one's height. The boxes
 * are read in one pass, once the toast has finished arriving.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

test('at 375px a toast sits above the bottom navigation bar and never covers it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${fixtureRoute('toast-region')}&bottom-tab-bar=1`, { waitUntil: 'load' });
  const bar = page.locator('[data-testid="bottom-tab-bar"] nav.cinder-navigation-bar');
  await bar.waitFor({ state: 'visible' });

  await page.getByRole('button', { name: 'Dismiss-after-action' }).click();
  const toast = page.locator('.cinder-toast', { hasText: 'Item moved to trash.' });
  await expect(toast).toBeVisible();
  await toast.evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );

  const read = await page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    return {
      bar: box('[data-testid="bottom-tab-bar"] nav.cinder-navigation-bar'),
      toast: box('.cinder-toast'),
    };
  });
  const { bar: barBox, toast: toastBox } = read;
  // The bar is at the bottom of the viewport, and the toast ends above its top edge.
  expect(barBox!.bottom).toBeGreaterThan(800);
  expect(toastBox!.bottom).toBeLessThanOrEqual(barBox!.top);
});

test('at 375px a toast sits above a docked action bar stacked on the bottom navigation bar, and covers neither', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${fixtureRoute('toast-region')}&docked-stack=1`, { waitUntil: 'load' });
  const navigation = page.locator('[data-testid="bottom-tab-bar"] nav.cinder-navigation-bar');
  await navigation.waitFor({ state: 'visible' });
  await page.locator('[data-testid="bottom-tab-bar"] .cinder-docked-action-bar').waitFor();

  await page.getByRole('button', { name: 'Dismiss-after-action' }).click();
  const toast = page.locator('.cinder-toast', { hasText: 'Item moved to trash.' });
  await expect(toast).toBeVisible();
  await toast.evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );

  const read = await page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    return {
      navigation: box('[data-testid="bottom-tab-bar"] nav.cinder-navigation-bar'),
      docked: box('[data-testid="bottom-tab-bar"] .cinder-docked-action-bar'),
      toast: box('.cinder-toast'),
    };
  });
  const navigationBox = read.navigation!;
  const dockedBox = read.docked!;
  const toastBox = read.toast!;
  const intersects = (
    first: { top: number; bottom: number; left: number; right: number },
    second: { top: number; bottom: number; left: number; right: number },
  ) =>
    first.left < second.right &&
    second.left < first.right &&
    first.top < second.bottom &&
    second.top < first.bottom;
  // The tab bar is at the bottom of the viewport with the docked bar on it, so the docked bar's top
  // is the highest edge; the toast ends above it and intersects neither bar.
  expect(navigationBox.bottom).toBeGreaterThan(800);
  expect(Math.abs(dockedBox.bottom - navigationBox.top)).toBeLessThan(1);
  expect(toastBox.bottom).toBeLessThanOrEqual(dockedBox.top);
  expect(intersects(toastBox, dockedBox)).toBe(false);
  expect(intersects(toastBox, navigationBox)).toBe(false);
});
