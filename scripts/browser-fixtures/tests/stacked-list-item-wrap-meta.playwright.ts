/// <reference lib="dom" />
/**
 * A `wrapMeta` row at a phone's 320px: line two is one run of text (the dot, the word, then the
 * meta), so a wrapped line returns to the row's text edge instead of wrapping in a column about
 * 90px wide beside the status word. Measured on the `wrap-meta` fixture; every box is read in one
 * pass.
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

test('a wrapped line two starts at the row’s text edge, not beside the status word', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(fixtureRoute('stacked-list-item', { fixtureName: 'wrap-meta' }), {
    waitUntil: 'load',
  });
  const row = page.locator('[data-testid="wrap-meta"] .cinder-stacked-list-item');
  await row.waitFor({ state: 'visible' });
  const read = await row.evaluate((element) => {
    const lineTwo = element.querySelector('.cinder-stacked-list-item__line-two');
    const meta = element.querySelector('.cinder-stacked-list-item__meta');
    const title = element.querySelector('.cinder-stacked-list-item__title');
    const inline = element.querySelector('.cinder-stacked-list-item__status-inline');
    const column = element.querySelector(
      '.cinder-stacked-list-item__layout > .cinder-stacked-list-item__status',
    );
    const rects = meta === null ? [] : [...meta.getClientRects()];
    return {
      lineTwoLeft: lineTwo?.getBoundingClientRect().left ?? Number.NaN,
      titleLeft: title?.getBoundingClientRect().left ?? Number.NaN,
      inlineShown: inline !== null && getComputedStyle(inline).display !== 'none',
      columnShown: column !== null && getComputedStyle(column).display !== 'none',
      columnDrawn: column !== null,
      statusImages: element.querySelectorAll('[role="img"][aria-label^="Check not met"]').length,
      lines: rects.map((rect) => ({ left: rect.left, top: rect.top })),
    };
  });
  // The word is on line two, in the run, and is the row's only status: no column copy is drawn,
  // so a screen reader names the status once.
  expect(read.inlineShown).toBe(true);
  expect(read.columnShown).toBe(false);
  expect(read.columnDrawn).toBe(false);
  expect(read.statusImages).toBe(1);
  // The meta wraps, and its second line starts at line two's own start edge, the row's text edge.
  expect(read.lines.length).toBeGreaterThan(1);
  const second = read.lines[1]!;
  expect(Math.abs(second.left - read.lineTwoLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(read.lineTwoLeft - read.titleLeft)).toBeLessThanOrEqual(1);
});

for (const width of [320, 375] as const) {
  test(`with a trailing action at ${String(width)}px, line two wraps beside the action and never runs under it`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(fixtureRoute('stacked-list-item', { fixtureName: 'wrap-meta' }), {
      waitUntil: 'load',
    });
    const row = page.locator('[data-testid="wrap-meta-action"] .cinder-stacked-list-item');
    await row.waitFor({ state: 'visible' });
    const read = await row.evaluate((element) => {
      const box = (selector: string) => {
        const found = element.querySelector(selector);
        if (!found) return null;
        const { top, bottom, left, right } = found.getBoundingClientRect();
        return { top, bottom, left, right };
      };
      return {
        lineTwo: box('.cinder-stacked-list-item__line-two'),
        trailing: box('.cinder-stacked-list-item__trailing'),
        statusImages: element.querySelectorAll('[role="img"][aria-label^="Check not met"]').length,
      };
    });
    const { lineTwo, trailing } = read;
    expect(read.statusImages).toBe(1);
    expect(lineTwo).not.toBeNull();
    expect(trailing).not.toBeNull();
    // The two boxes do not intersect: line two ends before the actions' column starts, or the
    // actions sit on a line of their own.
    const intersects =
      lineTwo!.left < trailing!.right &&
      trailing!.left < lineTwo!.right &&
      lineTwo!.top < trailing!.bottom &&
      trailing!.top < lineTwo!.bottom;
    expect(intersects).toBe(false);
  });
}
