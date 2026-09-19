import { expect, test } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

const GRID_ROUTE = fixtureRoute('grid');
const itemLeftOffsets = async (page: import('@playwright/test').Page, selector: string) => {
  const items = page.locator(selector);
  const lefts: number[] = [];
  for (let index = 0; index < (await items.count()); index += 1) {
    const box = await items.nth(index).boundingBox();
    if (box === null) throw new Error(`Missing bounding box for ${selector} #${index}`);
    lefts.push(Math.round(box.x));
  }
  return lefts;
};
const distinctLeftEdgeCount = async (page: import('@playwright/test').Page, selector: string) =>
  new Set(await itemLeftOffsets(page, selector)).size;

test.describe('Grid / bento mosaic recipe container-breakpoint collapse', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(GRID_ROUTE, { waitUntil: 'load' });
  });
  test('Grid resets to a single column only once its own width crosses 48rem', async ({ page }) => {
    const root = '#example-mount-narrow-collapse';
    const selector = `${root} .cinder-grid > div`;
    const grid = page.locator(`${root} .cinder-grid`);
    await expect(grid).toBeVisible();
    await expect(grid).toHaveAttribute('data-cinder-collapse', '');
    const wideBox = await grid.boundingBox();
    expect(wideBox).not.toBeNull();
    expect(wideBox!.width).toBeGreaterThan(768);
    await expect.poll(() => distinctLeftEdgeCount(page, selector)).toBe(3);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(async () => {
        const box = await grid.boundingBox();
        return box?.width ?? Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(768);
    await expect.poll(() => distinctLeftEdgeCount(page, selector)).toBe(1);
  });
  test('bento mosaic recipe (Grid + Grid.Item) collapses its cells at the same container breakpoint', async ({
    page,
  }) => {
    const root = '#example-mount-bento-mosaic';
    const selector = `${root} .cinder-grid-item`;
    const grid = page.locator(`${root} .cinder-grid`);
    await expect(grid).toBeVisible();
    await expect(grid).toHaveAttribute('data-cinder-collapse', '');
    const wideBox = await grid.boundingBox();
    expect(wideBox).not.toBeNull();
    expect(wideBox!.width).toBeGreaterThan(768);
    await expect.poll(() => distinctLeftEdgeCount(page, selector)).toBeGreaterThan(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(async () => {
        const box = await grid.boundingBox();
        return box?.width ?? Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(768);
    await expect.poll(() => distinctLeftEdgeCount(page, selector)).toBe(1);
  });
});
