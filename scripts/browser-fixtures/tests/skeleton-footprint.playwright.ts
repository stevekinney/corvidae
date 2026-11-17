/// <reference lib="dom" />
/**
 * COR-2449 (AC10): a list placeholder takes the space of the list it stands for, so the page does
 * not jump when the data arrives, and it draws no frame the loaded list does not draw. The skeleton
 * fixture holds a two-line pair and a three-line pair, each a `list` Skeleton above a loaded
 * DataList of two StackedListItem rows. happy-dom performs no layout, so it is measured here.
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

const WIDTHS = [
  { name: 'desktop', width: 1280 },
  { name: 'phone', width: 375 },
] as const;

for (const { name, width } of WIDTHS) {
  test.describe(`the list placeholder at ${name} width (${width}px)`, () => {
    for (const pair of ['two', 'three'] as const) {
      test(`the ${pair}-line placeholder is as tall as the loaded rows, row for row`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(fixtureRoute('skeleton'), { waitUntil: 'load' });
        const host = page.getByTestId(`skeleton-footprint-${pair}`);
        const placeholderRows = host.locator('.cinder-skeleton-row');
        const loadedRows = host.locator('.cinder-stacked-list-item');
        await expect(placeholderRows).toHaveCount(2);
        await expect(loadedRows).toHaveCount(2);

        const heights = async (rows: typeof placeholderRows) =>
          rows.evaluateAll((elements) =>
            elements.map((element) => {
              const style = getComputedStyle(element);
              // A row's height with the margin below it, which is what spaces the rows apart.
              return element.getBoundingClientRect().height + Number.parseFloat(style.marginBottom);
            }),
          );
        const placeholder = await heights(placeholderRows);
        const loaded = await heights(loadedRows);
        for (const [index, height] of placeholder.entries()) {
          expect(height).toBeCloseTo(loaded[index]!, 1);
        }

        const listHeight = (selector: string) =>
          host
            .locator(selector)
            .first()
            .evaluate((element) => element.getBoundingClientRect().height);
        const placeholderList = await listHeight('[data-testid="footprint-placeholder"]');
        const loadedList = await listHeight('[data-testid="footprint-loaded"]');
        expect(placeholderList).toBeCloseTo(loadedList, 1);
      });
    }
  });
}

test.describe('the list placeholder draws no frame by default', () => {
  test('there is no border, background or divider, as the loaded list has none', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('skeleton'), { waitUntil: 'load' });
    const list = page
      .getByTestId('skeleton-footprint-two')
      .locator('.cinder-skeleton-list')
      .first();
    await expect(list).toHaveCSS('border-top-width', '0px');
    await expect(list).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const rows = list.locator('.cinder-skeleton-row');
    await expect(rows.nth(1)).toHaveCSS('border-top-width', '0px');
  });
});
