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

  test('the action button fits inside the fixed column', async ({ page }) => {
    const actions = page.locator('.cinder-grouped-list-item__action');
    const count = await actions.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      const column = await actions.nth(index).boundingBox();
      const button = await actions.nth(index).locator('button').first().boundingBox();
      expect(button?.width, `button ${index} fits the 44px column`).toBeLessThanOrEqual(
        (column?.width ?? 0) + 0.5,
      );
      expect(button?.x).toBeGreaterThanOrEqual((column?.x ?? 0) - 0.5);
    }
  });

  test('in light, the group is a visible surface against its page', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    const [group, pageBackground] = await Promise.all([
      page
        .locator('.cinder-grouped-list__group')
        .first()
        .evaluate((element) => {
          return getComputedStyle(element).backgroundColor;
        }),
      page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    ]);
    expect(group).not.toBe(pageBackground);
    expect(group).not.toBe('rgb(255, 255, 255)');
    expect(group).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('a status is a 6px dot', async ({ page }) => {
    const indicator = page
      .locator('.cinder-status-dot[data-cinder-size="xs"] .cinder-status-dot__indicator')
      .first();
    await expect(indicator).toBeVisible();
    const box = await indicator.boundingBox();
    expect(box?.width).toBeCloseTo(6, 0);
    expect(box?.height).toBeCloseTo(6, 0);
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
});
