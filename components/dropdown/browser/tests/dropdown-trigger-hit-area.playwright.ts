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

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Browser, type Page } from '@playwright/test';

const PAINTED = 32;
const COARSE_HIT = 44;
/**
 * The fixture stacks three triggers with no gap between them (Options, Grouped menu, Row
 * regression), so a press 21px below Options lands on Grouped menu's painted face, which is right:
 * a neighbour's face takes the press over another control's invisible hit area, as with Button.
 * Each side is therefore probed where nothing else is drawn: above the first trigger, below the
 * last.
 */
const FIRST = '#example-mount-basic .cinder-dropdown-trigger';

async function openDropdown(page: Page): Promise<void> {
  await page.goto(fixtureRoute('dropdown'), { waitUntil: 'load' });
  await page.locator(FIRST).waitFor({ state: 'visible' });
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

/**
 * In one pass: the first trigger's painted height, its hit area's height (the pseudo-element's),
 * and whether presses at its centre and 21px above it land on it, and 21px below the last trigger
 * lands on that one. A miss names what was hit.
 */
function readTriggers(page: Page) {
  return page.evaluate((first) => {
    const firstTrigger = document.querySelector(first);
    const lastTrigger = [...document.querySelectorAll('.cinder-dropdown-trigger')].at(-1) ?? null;
    if (firstTrigger === null || lastTrigger === null) throw new Error('No trigger on the page.');
    const lands = (trigger: Element, offset: number) => {
      const box = trigger.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2 + offset);
      return hit !== null && trigger.contains(hit)
        ? 'trigger'
        : `${hit?.tagName.toLowerCase() ?? 'nothing'}.${hit?.className ?? ''}`;
    };
    const box = firstTrigger.getBoundingClientRect();
    const before = getComputedStyle(firstTrigger, '::before');
    return {
      height: box.height,
      hitHeight: before.position === 'absolute' ? Number.parseFloat(before.height) : box.height,
      centre: lands(firstTrigger, 0),
      above: lands(firstTrigger, -21),
      below: lands(lastTrigger, 21),
    };
  }, FIRST);
}

test.describe('Dropdown trigger, fine pointer', () => {
  test('paints 32px and answers only within its painted box', async ({ page }) => {
    await page.emulateMedia({ media: 'screen' });
    await openDropdown(page);
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(false);
    const read = await readTriggers(page);
    expect(read.height).toBeCloseTo(PAINTED, 0);
    expect(read.hitHeight).toBeCloseTo(PAINTED, 0);
    expect(read.centre).toBe('trigger');
    expect(read.above).not.toBe('trigger');
    expect(read.below).not.toBe('trigger');
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
      const read = await readTriggers(page);
      expect(read.height).toBeCloseTo(PAINTED, 0);
      expect(read.height).toBeLessThan(COARSE_HIT);
      expect(read.hitHeight).toBeGreaterThanOrEqual(COARSE_HIT);
      expect(read.centre).toBe('trigger');
      expect(read.above).toBe('trigger');
      expect(read.below).toBe('trigger');
    } finally {
      await close();
    }
  });
});
