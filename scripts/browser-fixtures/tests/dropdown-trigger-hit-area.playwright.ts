/// <reference lib="dom" />
/**
 * COR-2327 B2: a Dropdown trigger paints at a Button's painted height on every pointer (32px at
 * the default density) and, under a coarse pointer, reaches 44px through a hit-area pseudo-element
 * that takes no layout space, as Button does. Before, the raised `--cinder-button-height-md` drew
 * it 44px tall beside 32px buttons.
 *
 * happy-dom performs no layout, so the trigger is measured in a browser on the `dropdown`
 * assertion fixture, and the hit area is proven by what a press 21px above and below the centre
 * lands on, read in one pass. A coarse pointer is resolved by Chromium from the context's
 * `hasTouch` and `isMobile`, not from `page.emulateMedia`.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

const PAINTED = 32;
const COARSE_HIT = 44;
const TRIGGER = '#example-mount-basic .cinder-dropdown-trigger';

async function openDropdown(page: Page): Promise<void> {
  await page.goto(fixtureRoute('dropdown'), { waitUntil: 'load' });
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

/** The trigger's painted box and whether presses at its centre and 21px above and below land on it. */
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

test.describe('Dropdown trigger, fine pointer', () => {
  test('paints 32px and answers only within its painted box', async ({ page }) => {
    await page.emulateMedia({ media: 'screen' });
    await openDropdown(page);
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(false);
    const read = await readTrigger(page);
    expect(read.height).toBeCloseTo(PAINTED, 0);
    expect(read.centre).toBe(true);
    expect(read.above).toBe(false);
    expect(read.below).toBe(false);
  });
});

test.describe('Dropdown trigger, coarse pointer', () => {
  test('paints 32px, a Button’s painted height, and answers a press 44px tall', async ({
    browser,
  }) => {
    const { page, close } = await coarsePage(browser);
    try {
      await openDropdown(page);
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
      const read = await readTrigger(page);
      expect(read.height).toBeCloseTo(PAINTED, 0);
      expect(read.height).toBeLessThan(COARSE_HIT);
      expect(read.centre).toBe(true);
      expect(read.above).toBe(true);
      expect(read.below).toBe(true);
    } finally {
      await close();
    }
  });
});
