/// <reference lib="dom" />
/**
 * COR-2329: Link's `more` form, the way out of a section to the page that holds the rest ("Open
 * Reviews ›"). It is small regular text, quieter than the heading beside it, ends in a chevron,
 * stays on one line, and under a coarse pointer reaches a 44px hit area that takes no layout. The
 * hit area is probed with `elementFromPoint`, as the link popover's close button is, because it is
 * a pseudo-element with no box of its own. A coarse pointer is resolved by Chromium from the
 * context's `hasTouch` and `isMobile`, not from `page.emulateMedia`.
 */

import { expect, test, type Locator } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

/** The sides of the link's center on which a tap 21.5 pixels away still lands on the link. */
async function reachedSides(link: Locator): Promise<string[]> {
  return link.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    const centerX = rectangle.x + rectangle.width / 2;
    const centerY = rectangle.y + rectangle.height / 2;
    return (
      [
        ['above', centerX, centerY - 21.5],
        ['below', centerX, centerY + 21.5],
      ] as const
    )
      .filter(([, x, y]) => element.contains(document.elementFromPoint(x, y)))
      .map(([side]) => side);
  });
}

test.describe('Link more form', () => {
  test('is small regular text with a chevron after the words, quieter than its heading', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('link'), { waitUntil: 'load' });
    const row = page.getByTestId('link-more');
    const link = row.getByRole('link', { name: 'Open Reviews' });
    const smallText = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.fontSize = 'var(--cinder-text-sm)';
      document.body.append(probe);
      const size = getComputedStyle(probe).fontSize;
      probe.remove();
      return size;
    });
    await expect(link).toHaveCSS('font-size', smallText);
    await expect(link).toHaveCSS('font-weight', '400');
    await expect(link).toHaveCSS('white-space', 'nowrap');
    const headingSize = await row
      .getByRole('heading', { name: 'Needs you' })
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(headingSize).toBeGreaterThan(Number.parseFloat(smallText));
    const [words, chevron] = await Promise.all([
      link.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element.firstChild ?? element);
        return range.getBoundingClientRect().right;
      }),
      link.locator('.cinder-link__chevron').boundingBox(),
    ]);
    expect(chevron!.x).toBeGreaterThanOrEqual(words - 1);
    // A fine pointer gets no enlarged hit area, so a tap above the text misses it.
    expect(await reachedSides(link)).toEqual([]);
  });

  test('reaches a 44px hit area under a coarse pointer without growing its face', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1,
      viewport: { width: 375, height: 800 },
    });
    try {
      const page = await context.newPage();
      await page.goto(fixtureRoute('link'), { waitUntil: 'load' });
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
      const link = page.getByTestId('link-more').getByRole('link', { name: 'Open Reviews' });
      const face = await link.boundingBox();
      expect(face!.height).toBeLessThan(24);
      expect(await reachedSides(link)).toEqual(['above', 'below']);
    } finally {
      await context.close();
    }
  });
});
