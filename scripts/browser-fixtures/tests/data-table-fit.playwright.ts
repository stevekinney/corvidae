/// <reference lib="dom" />
import { expect, test, type Locator } from '@playwright/test';

import { fixtureRoute, setFixtureWidth } from './layout-fixture.ts';

async function widths(wrapper: Locator) {
  return wrapper.locator('.cinder-data-table').evaluate((node) => ({
    client: node.clientWidth,
    scroll: node.scrollWidth,
  }));
}

test('fit DataTable wraps where the standard table scrolls', async ({ page }) => {
  await page.goto(`${fixtureRoute('data-table')}&fit=1`, { waitUntil: 'load' });
  const fit = page.getByTestId('fit-table');
  const standard = page.getByTestId('scrolling-table');
  await setFixtureWidth(fit, '390px');
  await setFixtureWidth(standard, '390px');
  await expect(fit.locator('[data-cinder-stack-card]')).toBeVisible();
  const wrapped = await widths(fit);
  const scrolling = await widths(standard);
  expect(wrapped.scroll).toBeLessThanOrEqual(wrapped.client);
  expect(scrolling.scroll).toBeGreaterThan(scrolling.client);
});

test('fit DataTable can select and sort without horizontal overflow', async ({ page }) => {
  await page.goto(`${fixtureRoute('data-table')}&fit=1`, { waitUntil: 'load' });
  const fit = page.getByTestId('selectable-fit');
  await setFixtureWidth(fit, '390px');
  await expect(fit.locator('[data-cinder-stack-card]')).toBeVisible();
  const measured = await widths(fit);
  expect(measured.scroll).toBeLessThanOrEqual(measured.client);
  const row = fit.getByRole('checkbox', { name: 'Select North America delivery workflow' });
  await expect(row).toBeVisible();
  await row.check();
  await expect(row).toBeChecked();
  await expect(fit.getByLabel('Sort by')).toBeVisible();
  const layout = await fit.locator('.cinder-data-table').evaluate((wrapper) => {
    const sort = wrapper.querySelector('.cinder-table__stack-sort')!.getBoundingClientRect();
    const table = wrapper.querySelector('[data-cinder-stack-card]')!.getBoundingClientRect();
    const bounds = wrapper.getBoundingClientRect();
    // The scroll box pads its start by the gutter the row tint reaches into (COR-2760), so the
    // table is flush with its content box, not its border box.
    const style = getComputedStyle(wrapper);
    return {
      sortBottom: sort.bottom,
      tableTop: table.top,
      left: table.left - (bounds.left + Number.parseFloat(style.paddingLeft)),
      right: bounds.right - Number.parseFloat(style.paddingRight) - table.right,
    };
  });
  expect(layout.tableTop).toBeGreaterThanOrEqual(layout.sortBottom - 1);
  expect(Math.abs(layout.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.right)).toBeLessThanOrEqual(1);
});
