/// <reference lib="dom" />
/**
 * COR-2825: an InlineConfirm strip dismisses with a quiet icon-only X named "Cancel", before the
 * confirm action, which keeps the trailing edge. Under a coarse pointer the X paints at its extra
 * small size and answers a press 44px tall and wide through Button's positioned pseudo-element,
 * which takes no layout space, so the strip adds no spacing between the X and the confirm action.
 *
 * happy-dom performs no layout, so the X is measured in a browser on the `inline-confirm` fixture.
 * The hit area is proven by what a press 21px above, below and toward the start of the X's centre
 * lands on, read in one pass. The side toward the confirm action is not probed: the two targets
 * meet there within the actions' gap. A coarse pointer is resolved by Chromium from the context's
 * `hasTouch` and `isMobile`, not from `page.emulateMedia`.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

const DISMISS = '.cinder-inline-confirm [data-cinder-inline-cancel]';

test.describe('InlineConfirm strip, coarse pointer at 375px', () => {
  test('the quiet X precedes the confirm action and answers a 44px press', async ({ browser }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1,
      viewport: { width: 375, height: 812 },
    });
    try {
      const page = await context.newPage();
      await page.goto(fixtureRoute('inline-confirm'), { waitUntil: 'load' });
      const dismiss = page.getByRole('button', { name: 'Cancel' });
      await expect(dismiss).toBeVisible();
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);

      const read = await page.evaluate((selector) => {
        const button = document.querySelector<HTMLElement>(selector);
        if (button === null) throw new Error('The dismissing X is not on the page.');
        const actions = [
          ...document.querySelectorAll('.cinder-inline-confirm__actions .cinder-button'),
        ];
        const visible = button.cloneNode(true) as HTMLElement;
        for (const hidden of visible.querySelectorAll('.cinder-sr-only')) hidden.remove();
        const box = button.getBoundingClientRect();
        const centreX = box.x + box.width / 2;
        const centreY = box.y + box.height / 2;
        const startward = getComputedStyle(button).direction === 'rtl' ? 21 : -21;
        const lands = (x: number, y: number) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && button.contains(hit);
        };
        return {
          visibleText: visible.textContent?.trim() ?? '',
          first: actions[0] === button,
          count: actions.length,
          confirmLast: actions.at(-1)?.textContent?.trim() ?? '',
          centre: lands(centreX, centreY),
          above: lands(centreX, centreY - 21),
          below: lands(centreX, centreY + 21),
          start: lands(centreX + startward, centreY),
        };
      }, DISMISS);

      expect(read.visibleText).toBe('');
      expect(read.count).toBe(2);
      expect(read.first).toBe(true);
      expect(read.confirmLast).toBe('Remove workspace');
      expect(read.centre).toBe(true);
      expect(read.above).toBe(true);
      expect(read.below).toBe(true);
      expect(read.start).toBe(true);
    } finally {
      await context.close();
    }
  });
});
