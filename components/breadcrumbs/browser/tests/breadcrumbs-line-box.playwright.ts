/// <reference lib="dom" />
/**
 * COR-2327: at 1280 a crumb link's box is a whole number of pixels tall, the type scale's line height
 * for the trail's 13px text (20px), and the link, the separators, the current crumb and the title
 * selector beside them share one centre line. Before, the link inherited the page's 1.5 line height
 * on 13px text, a 19.5px box, so its centre sat on a half pixel. Measured on the `breadcrumbs`
 * assertion fixture, the plain trail and the trail with a selector (`?popover=1`), in one pass.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

test('at 1280px a crumb link is 20px tall and shares a centre line with its separators and the selector', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${fixtureRoute('breadcrumbs')}&popover=1`, { waitUntil: 'load' });
  await page.locator('[data-testid="popover-trail"] .cinder-breadcrumbs__trigger').waitFor();

  const read = await page.evaluate(() => {
    const boxes = (root: Element | Document, selector: string) =>
      [...root.querySelectorAll(selector)].map((element) => {
        const { top, height } = element.getBoundingClientRect();
        return { height, centre: top + height / 2 };
      });
    const trails = [...document.querySelectorAll('nav.cinder-breadcrumbs')];
    return trails.map((trail) => ({
      links: boxes(trail, '.cinder-breadcrumbs__link'),
      separators: boxes(trail, '.cinder-breadcrumbs__separator'),
      current: boxes(trail, '.cinder-breadcrumbs__current'),
    }));
  });

  expect(read).toHaveLength(2);
  for (const trail of read) {
    expect(trail.links.length).toBeGreaterThan(0);
    for (const link of trail.links) expect(link.height).toBe(20);
    const centre = trail.links[0]!.centre;
    for (const box of [...trail.links, ...trail.separators, ...trail.current]) {
      expect(Math.abs(box.centre - centre)).toBeLessThan(0.5);
    }
  }
});
