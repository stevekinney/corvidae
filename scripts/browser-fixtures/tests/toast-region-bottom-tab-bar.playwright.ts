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

for (const width of [320, 375]) {
  test(`at ${width}px a toast sits above the bottom navigation bar without blocking Home or More`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.goto(`${fixtureRoute('toast-region')}&bottom-tab-bar=1`, { waitUntil: 'load' });
    const bar = page.locator('[data-testid="bottom-tab-bar"] nav.cinder-navigation-bar');
    const home = page.locator('[data-testid="bottom-tab-bar"] a[href="#home"]');
    const more = page.locator('[data-testid="bottom-tab-bar"] a[href="#more"]');
    await bar.waitFor({ state: 'visible' });
    await expect(home).toBeVisible();
    await expect(more).toBeVisible();

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
        home: box('[data-testid="bottom-tab-bar"] a[href="#home"]'),
        more: box('[data-testid="bottom-tab-bar"] a[href="#more"]'),
      };
    });
    const { bar: barBox, toast: toastBox, home: homeBox, more: moreBox } = read;
    // The bar is at the bottom of the viewport, and the toast ends above its top edge. Its one
    // geometry read includes the Home and More controls, which remain outside the toast's bounds.
    expect(barBox!.bottom).toBeGreaterThan(800);
    expect(toastBox!.bottom).toBeLessThanOrEqual(barBox!.top);
    expect(homeBox!.top).toBeGreaterThanOrEqual(barBox!.top);
    expect(moreBox!.top).toBeGreaterThanOrEqual(barBox!.top);
  });
}

test('at 375px Undo has a 44px clickable extension without enlarging its painted label', async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 375, height: 812 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`${fixtureRoute('toast-region')}&bottom-tab-bar=1`, { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Dismiss-after-action' }).click();
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();
    const hitArea = await undo.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const topTarget = document.elementFromPoint(x, y - 21);
      const bottomTarget = document.elementFromPoint(x, y + 21);
      return {
        height: box.height,
        topHitsUndo: topTarget?.closest('.cinder-toast__action') === button,
        bottomHitsUndo: bottomTarget?.closest('.cinder-toast__action') === button,
        x,
        y: y - 21,
      };
    });
    expect(hitArea.height).toBeLessThan(44);
    expect(hitArea.topHitsUndo).toBe(true);
    expect(hitArea.bottomHitsUndo).toBe(true);
    await page.touchscreen.tap(hitArea.x, hitArea.y);
    await expect(page.locator('.children-p').filter({ hasText: 'Undo fired: 1' })).toHaveText(
      'Undo fired: 1 Pause fired: 0',
    );
    await expect(undo).toBeHidden();
  } finally {
    await context.close();
  }
});

test('at desktop Undo has a 24px clickable extension without enlarging its painted label', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(fixtureRoute('toast-region'), { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Dismiss-after-action' }).click();
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeVisible();
  const hitArea = await undo.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const topTarget = document.elementFromPoint(x, y - 11);
    const bottomTarget = document.elementFromPoint(x, y + 11);
    return {
      height: box.height,
      topHitsUndo: topTarget?.closest('.cinder-toast__action') === button,
      bottomHitsUndo: bottomTarget?.closest('.cinder-toast__action') === button,
      x,
      y: y - 11,
    };
  });
  expect(hitArea.height).toBeLessThan(24);
  expect(hitArea.topHitsUndo).toBe(true);
  expect(hitArea.bottomHitsUndo).toBe(true);
  await page.mouse.click(hitArea.x, hitArea.y);
  await expect(page.locator('.children-p').filter({ hasText: 'Undo fired: 1' })).toHaveText(
    'Undo fired: 1 Pause fired: 0',
  );
  await expect(undo).toBeHidden();
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
