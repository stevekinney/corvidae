/// <reference lib="dom" />
/**
 * COR-2426: at 320 by 640 a DockedActionBar at the end of a page taller than the screen keeps its
 * actions in view above a phone shell's bottom tab bar before anything is scrolled: it sticks to the
 * bottom of the scrolling page, which ends where the tab bar starts, and covers no tab. Measured on
 * the `toast-region` assertion fixture with `?docked-page=1`, a column the height of the viewport
 * with the scrolling page above an in-flow bottom NavigationBar, as Interborough's shell lays a
 * phone out. The page keeps 12px of bottom padding and names it in
 * `--cinder-docked-action-bar-end-offset`, so the bar sits flush on the tabs over that padding,
 * not 12px above them. The boxes are read in one pass.
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

test('at 320px a docked action bar sits above the bottom tab bar, in view before any scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`${fixtureRoute('toast-region')}&docked-page=1`, { waitUntil: 'load' });
  const approve = page.locator('[data-testid="docked-page"] .cinder-docked-action-bar button', {
    hasText: 'Approve',
  });
  await approve.waitFor({ state: 'visible' });

  const read = await page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { top, bottom } = element.getBoundingClientRect();
      return { top, bottom };
    };
    const scroller = document.querySelector('[data-testid="docked-page-scroll"]');
    return {
      scrolled: scroller?.scrollTop ?? -1,
      overflows: scroller === null ? false : scroller.scrollHeight > scroller.clientHeight,
      bar: box('[data-testid="docked-page"] .cinder-docked-action-bar'),
      tabs: box('[data-testid="docked-page"] nav.cinder-navigation-bar'),
      approve: box('[data-testid="docked-page"] .cinder-docked-action-bar button:last-of-type'),
    };
  });
  // Nothing has been scrolled, and the page is taller than the room it has.
  expect(read.scrolled).toBe(0);
  expect(read.overflows).toBe(true);
  // The tab bar is at the bottom of the viewport; the docked bar ends where it starts, and its
  // primary action is wholly on screen above the tabs.
  expect(read.tabs!.bottom).toBeGreaterThan(630);
  expect(Math.abs(read.bar!.bottom - read.tabs!.top)).toBeLessThan(1);
  expect(read.approve!.top).toBeGreaterThanOrEqual(0);
  expect(read.approve!.bottom).toBeLessThanOrEqual(read.tabs!.top);
});
