/// <reference lib="dom" />
/** COR-2465: a docked Select listbox is flush with both physical viewport edges on phones. */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

for (const width of [320, 375]) {
  test(`the Select listbox sheet reaches both viewport edges at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.goto(fixtureRoute('select', { fixtureName: 'docked' }), { waitUntil: 'load' });
    await page.getByRole('combobox', { name: 'Environment' }).click();

    const panel = page.locator('.cinder-select__panel[data-cinder-sheet="docked"]');
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box!.x + box!.width - width)).toBeLessThanOrEqual(1);
  });
}
