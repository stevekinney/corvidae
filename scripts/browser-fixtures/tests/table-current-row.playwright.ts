/// <reference lib="dom" />
import { expect, test, type Locator } from '@playwright/test';

import { fixtureRoute, setFixtureWidth } from './layout-fixture.ts';

function background(row: Locator): Promise<string> {
  return row.evaluate((node) => getComputedStyle(node).backgroundColor);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`current Table rows match open DataTable rows in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto(`${fixtureRoute('table')}&current=1`, { waitUntil: 'load' });
    await page
      .locator('html')
      .evaluate((node, theme) => node.setAttribute('data-theme', theme), colorScheme);
    const current = page.getByTestId('plain-current').locator('[data-cinder-current]');
    const open = page.getByTestId('data-open').locator('[data-cinder-open]');
    await expect(current).toHaveAttribute('aria-current', 'true');
    const tint = await background(open);
    expect(tint).not.toBe('rgba(0, 0, 0, 0)');
    expect(await background(current)).toBe(tint);
    await current.hover();
    expect(await background(current)).toBe(tint);
    await open.focus();
    await expect(open).toBeFocused();
    expect(await background(open)).toBe(tint);
  });
}

test('the stacked current card has the same row tint', async ({ page }) => {
  await page.goto(`${fixtureRoute('table')}&current=1`, { waitUntil: 'load' });
  const wrapper = page.getByTestId('stacked-current');
  await setFixtureWidth(wrapper, '300px');
  const stacked = wrapper.locator('[data-cinder-stack-card] [data-cinder-current]');
  await expect(stacked).toBeVisible();
  const open = page.getByTestId('data-open').locator('[data-cinder-open]');
  // A card row draws its tint on its `::after`, which reaches past the row's start (COR-2760), and
  // paints nothing on the row itself.
  const cardTint = await stacked.evaluate(
    (node) => getComputedStyle(node, '::after').backgroundColor,
  );
  expect(cardTint).toBe(await background(open));
  expect(await background(stacked)).toBe('rgba(0, 0, 0, 0)');
});
