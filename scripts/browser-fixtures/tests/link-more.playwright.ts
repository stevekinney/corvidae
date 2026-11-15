/// <reference lib="dom" />
/**
 * COR-2329: Link's `more` form, the way out of a section to the page that holds the rest ("Open
 * Reviews ›"). It is small regular text, quieter than the heading beside it, ends in a chevron,
 * stays on one line, and reaches a hit area that takes no layout: 24px under a mouse and 44px under
 * a coarse pointer, which a list row drawn directly beneath it never covers. The hit area is probed
 * with `elementFromPoint`, as the link popover's close button is, because it is a pseudo-element
 * with no box of its own. A coarse pointer is resolved by Chromium from the context's `hasTouch`
 * and `isMobile`, not from `page.emulateMedia`.
 */

import { expect, test, type Locator } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

/** The sides of the link's center on which a tap `distance` pixels away still lands on the link. */
async function reachedSides(link: Locator, distance: number): Promise<string[]> {
  return link.evaluate((element, away) => {
    const rectangle = element.getBoundingClientRect();
    const centerX = rectangle.x + rectangle.width / 2;
    const centerY = rectangle.y + rectangle.height / 2;
    return (
      [
        ['above', centerX, centerY - away],
        ['below', centerX, centerY + away],
      ] as const
    )
      .filter(([, x, y]) => element.contains(document.elementFromPoint(x, y)))
      .map(([side]) => side);
  }, distance);
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
  });

  test('reaches a 24px hit area under a mouse, and no further', async ({ page }) => {
    await page.goto(fixtureRoute('link'), { waitUntil: 'load' });
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(false);
    for (const testId of ['link-more', 'link-more-over-row']) {
      const link = page.getByTestId(testId).getByRole('link', { name: /^Open/ });
      const face = await link.boundingBox();
      expect(face!.height).toBeLessThan(24);
      // Just inside the 24px edges, above and below; the row beneath does not take the lower edge.
      expect(await reachedSides(link, 11.5), testId).toEqual(['above', 'below']);
      // Just outside them, the tap misses.
      expect(await reachedSides(link, 13), testId).toEqual([]);
    }
  });

  test('reaches a 44px hit area under a coarse pointer without growing its face, over the row beneath', async ({
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
      for (const testId of ['link-more', 'link-more-over-row']) {
        const link = page.getByTestId(testId).getByRole('link', { name: /^Open/ });
        const face = await link.boundingBox();
        expect(face!.height).toBeLessThan(24);
        expect(await reachedSides(link, 21.5), testId).toEqual(['above', 'below']);
        expect(await reachedSides(link, 23), testId).toEqual([]);
      }
      // The row really is directly beneath: the link's lower hit edge lies over the row's box.
      const over = page.getByTestId('link-more-over-row');
      const [link, row] = await Promise.all([
        over.getByRole('link', { name: 'Open Health' }).boundingBox(),
        over.locator('.cinder-grouped-list-item').boundingBox(),
      ]);
      expect(link!.y + link!.height / 2 + 21.5).toBeGreaterThan(row!.y);
    } finally {
      await context.close();
    }
  });
});
