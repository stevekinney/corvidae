/// <reference lib="dom" />
/**
 * COR-2448: a StackedListItem chooses its layout from its own container width, not the viewport's.
 * In a 360px pane of a 1280px window the row takes its phone form (the status moves to line two),
 * so the name column is not crushed. happy-dom performs no layout, so it is measured in a browser
 * on the pane the `narrow-trailing` fixture draws under its two rows.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';
import { boxOf } from './first-line-alignment.ts';

test.describe('StackedListItem in a narrow pane of a wide viewport', () => {
  test('the name column is wider than 120px in a 360px pane at 1280px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(fixtureRoute('stacked-list-item', { fixtureName: 'narrow-trailing' }), {
      waitUntil: 'load',
    });
    const row = page.locator('[data-testid="pane"] .cinder-stacked-list-item');
    await row.waitFor({ state: 'visible' });
    await expect(row).toHaveAttribute('data-cinder-phone', '');
    const title = await boxOf(row.locator('.cinder-stacked-list-item__title'));
    expect(title.right - title.left).toBeGreaterThan(120);
  });
});
