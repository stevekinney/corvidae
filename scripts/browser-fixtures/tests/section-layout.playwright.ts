import { expect, test } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

test.describe('Section layout', () => {
  test('a tall Section keeps every child inside a short flex scroll parent', async ({ page }) => {
    await page.goto(fixtureRoute('section'), { waitUntil: 'load' });
    const rows = page.locator('.section-row');
    await expect(rows).toHaveCount(8);
    for (let index = 0; index < 8; index += 1) {
      const box = await rows.nth(index).boundingBox();
      expect(box?.height, `row ${index} keeps its 48px height`).toBeGreaterThanOrEqual(47.5);
    }
    // The parent scrolls instead of squeezing the Section.
    const scroll = await page
      .locator('#section-scroll-parent')
      .evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }));
    expect(scroll.scroll).toBeGreaterThan(scroll.client);
    // Neither Section is shrunk below its content, so the second still has its full heading.
    const sections = page.locator('.cinder-section');
    const first = await sections.nth(0).boundingBox();
    expect(first?.height).toBeGreaterThanOrEqual(8 * 48);
  });

  test('the Section draws no box', async ({ page }) => {
    await page.goto(fixtureRoute('section'), { waitUntil: 'load' });
    const section = page.locator('.cinder-section').first();
    await expect(section).toHaveCSS('border-top-width', '0px');
    await expect(section).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  });
});

test.describe('GroupedList layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(fixtureRoute('grouped-list'), { waitUntil: 'load' });
  });

  test('separators start at the text and the last row has none', async ({ page }) => {
    const first = page.locator('.cinder-grouped-list-item').first();
    await expect(first.locator('.cinder-grouped-list-item__content')).toHaveCSS(
      'border-bottom-style',
      'solid',
    );
    await expect(first).toHaveCSS('border-bottom-width', '0px');
    const last = page.locator('.cinder-grouped-list-item').last();
    await expect(last.locator('.cinder-grouped-list-item__content')).toHaveCSS(
      'border-bottom-color',
      'rgba(0, 0, 0, 0)',
    );
  });

  test('the action column is fixed, so a longer value never moves the click target', async ({
    page,
  }) => {
    const actions = page.locator('.cinder-grouped-list-item__action');
    const [one, two] = await Promise.all([
      actions.nth(0).boundingBox(),
      actions.nth(1).boundingBox(),
    ]);
    expect(one?.width).toBeCloseTo(44, 0);
    expect(two?.width).toBeCloseTo(44, 0);
    expect(one?.x).toBeCloseTo(two?.x ?? 0, 0);
  });

  test('the whole row is the link', async ({ page }) => {
    const row = page.locator('.cinder-grouped-list-item').first();
    const link = row.locator('.cinder-grouped-list-item__link');
    const [rowBox, overlay] = await Promise.all([
      row.boundingBox(),
      link.evaluate((element) => {
        const rectangle = getComputedStyle(element, '::after');
        return { position: rectangle.position, inset: rectangle.top };
      }),
    ]);
    expect(rowBox).not.toBeNull();
    expect(overlay.position).toBe('absolute');
    expect(overlay.inset).toBe('0px');
  });

  test('the grouped skeleton draws the grouped list surface, and its button block stacks on a phone (COR-2329)', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('skeleton'), { waitUntil: 'load' });
    const surface = page.getByTestId('skeleton-grouped').locator('.cinder-skeleton-grouped');
    await expect(surface).toHaveCSS('border-top-width', '0px');
    await expect(surface).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const rows = surface.locator('.cinder-skeleton-grouped-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first().locator('.cinder-skeleton-grouped-content')).toHaveCSS(
      'border-bottom-style',
      'solid',
    );
    await page.setViewportSize({ width: 1024, height: 800 });
    const wide = await rows.first().locator('.cinder-skeleton-action-bar').boundingBox();
    expect(wide!.width).toBeCloseTo(84, 0);
    // A placeholder row is as tall as a real row with a title, a subtitle and an action, so nothing
    // moves when the rows arrive.
    const placeholderHeight = (await rows.first().boundingBox())!.height;
    await page.goto(fixtureRoute('grouped-list'), { waitUntil: 'load' });
    const real = page
      .getByTestId('grouped-list-actions')
      .locator('.cinder-grouped-list-item')
      .nth(1);
    expect(Math.abs((await real.boundingBox())!.height - placeholderHeight)).toBeLessThanOrEqual(1);
    await page.goto(fixtureRoute('skeleton'), { waitUntil: 'load' });
    await page.setViewportSize({ width: 375, height: 800 });
    const row = await rows.first().boundingBox();
    const text = await rows.first().locator('.cinder-skeleton-grouped-text').boundingBox();
    const block = await rows.first().locator('.cinder-skeleton-action-bar').boundingBox();
    expect(block!.y).toBeGreaterThanOrEqual(text!.y + text!.height - 1);
    expect(block!.width).toBeGreaterThan(row!.width - 40);
  });

  test('text actions trail their row on a wide screen (COR-2329)', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    const rows = page.getByTestId('grouped-list-actions').locator('.cinder-grouped-list-item');
    const row = await rows.nth(0).boundingBox();
    const button = await rows.nth(0).getByRole('link', { name: 'Answer' }).boundingBox();
    expect(button!.x + button!.width).toBeGreaterThan(row!.x + row!.width - 40);
    expect(button!.width).toBeLessThan(row!.width / 3);
  });

  test('text actions stack full width under the text on a phone (COR-2329)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const rows = page.getByTestId('grouped-list-actions').locator('.cinder-grouped-list-item');
    for (const [index, name] of [
      [0, 'Answer'],
      [1, 'View run'],
    ] as const) {
      const row = await rows.nth(index).boundingBox();
      const text = await rows.nth(index).locator('.cinder-grouped-list-item__text').boundingBox();
      const button = await rows.nth(index).getByRole('link', { name }).boundingBox();
      expect(button!.y, `${name} is under its text`).toBeGreaterThanOrEqual(
        text!.y + text!.height - 1,
      );
      expect(button!.width, `${name} is the row's width`).toBeGreaterThan(row!.width - 40);
    }
  });
});
