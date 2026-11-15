/// <reference lib="dom" />
/**
 * COR-2327: a bottom NavigationBar (a phone's tab bar) publishes its height as a docked action bar
 * does, so a toast that stays until it is dismissed sits above the tabs, not over them. Measured on
 * the `toast-region` assertion fixture with `?bottom-tab-bar=1`, which adds the bar without
 * touching the default fixture's baselines. Both boxes are read in one pass, once the toast has
 * finished arriving.
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

test('at 375px a toast sits above the bottom navigation bar and never covers it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${fixtureRoute('toast-region')}&bottom-tab-bar=1`, { waitUntil: 'load' });
  const bar = page.locator('[data-testid="bottom-tab-bar"] .cinder-navigation-bar');
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
      bar: box('[data-testid="bottom-tab-bar"] .cinder-navigation-bar'),
      toast: box('.cinder-toast'),
    };
  });
  const { bar: barBox, toast: toastBox } = read;
  // The bar is at the bottom of the viewport, and the toast ends above its top edge.
  expect(barBox!.bottom).toBeGreaterThan(800);
  expect(toastBox!.bottom).toBeLessThanOrEqual(barBox!.top);
});
