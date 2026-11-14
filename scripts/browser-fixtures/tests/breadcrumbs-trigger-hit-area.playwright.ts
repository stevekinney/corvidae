/// <reference lib="dom" />
/**
 * COR-2327 B2: Breadcrumbs' current page drawn as a popover trigger (a chat's title switcher)
 * paints 30px on every pointer and, under a coarse pointer, answers a press 44px tall through a
 * positioned pseudo-element that takes no layout space; the trail's list makes room for it inside
 * its own clip. A fine pointer answers only within the painted button.
 *
 * happy-dom performs no layout, so the trigger is measured in a browser on the `breadcrumbs`
 * assertion fixture with `?popover=1`, which adds the trail without touching the default fixture's
 * baselines. The hit area is proven by what a press 21px above and below the centre lands on, read
 * in one pass. A coarse pointer is resolved by Chromium from the context's `hasTouch` and
 * `isMobile`, not from `page.emulateMedia`.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

const PAINTED = 30;
const TRIGGER = '[data-testid="popover-trail"] .cinder-breadcrumbs__trigger';

async function openTrail(page: Page): Promise<void> {
  await page.goto(`${fixtureRoute('breadcrumbs')}&popover=1`, { waitUntil: 'load' });
  await page.locator(TRIGGER).waitFor({ state: 'visible' });
}

async function coarsePage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
    viewport: { width: 390, height: 844 },
  });
  return { page: await context.newPage(), close: () => context.close() };
}

/** The trigger's painted height and whether presses at its centre and 21px above and below land on it. */
function readTrigger(page: Page) {
  return page.evaluate((selector) => {
    const trigger = document.querySelector(selector);
    if (trigger === null) throw new Error('The trigger is not on the page.');
    const box = trigger.getBoundingClientRect();
    const centreX = box.x + box.width / 2;
    const centreY = box.y + box.height / 2;
    const lands = (y: number) => {
      const hit = document.elementFromPoint(centreX, y);
      return hit !== null && trigger.contains(hit);
    };
    return {
      height: box.height,
      centre: lands(centreY),
      above: lands(centreY - 21),
      below: lands(centreY + 21),
    };
  }, TRIGGER);
}

test.describe('Breadcrumbs popover trigger, fine pointer', () => {
  test('paints 30px and answers only within its painted box', async ({ page }) => {
    await page.emulateMedia({ media: 'screen' });
    await openTrail(page);
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(false);
    const read = await readTrigger(page);
    expect(read.height).toBeCloseTo(PAINTED, 0);
    expect(read.centre).toBe(true);
    expect(read.above).toBe(false);
    expect(read.below).toBe(false);
  });
});

test.describe('Breadcrumbs popover trigger, coarse pointer', () => {
  test('paints 30px and answers a press 44px tall', async ({ browser }) => {
    const { page, close } = await coarsePage(browser);
    try {
      await openTrail(page);
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
      const read = await readTrigger(page);
      expect(read.height).toBeCloseTo(PAINTED, 0);
      expect(read.centre).toBe(true);
      expect(read.above).toBe(true);
      expect(read.below).toBe(true);
    } finally {
      await close();
    }
  });
});
