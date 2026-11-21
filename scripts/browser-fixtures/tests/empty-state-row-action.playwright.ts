/// <reference lib="dom" />
/**
 * COR-2431: the shared EmptyState places its action after the copy at the inline end of the
 * reading measure, even if the column is narrow.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

for (const width of [320, 1280] as const) {
  test(`the empty state aligns its action to the inline end at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(fixtureRoute('empty-state', { fixtureName: 'row-action' }), {
      waitUntil: 'load',
    });
    for (const name of ['wide', 'narrow']) {
      const column = page.getByTestId(`column-${name}`);
      await expect(column.getByRole('link', { name: 'Open Health' })).toBeVisible();
      const geometry = await column.evaluate((element) => {
        const rect = (selector: string) =>
          element.querySelector(selector)!.getBoundingClientRect().toJSON() as DOMRect;
        return {
          description: rect('.cinder-empty-state-description'),
          action: rect('.cinder-empty-state-action > *'),
          actions: rect('.cinder-empty-state-action'),
        };
      });
      expect(geometry.action.top).toBeGreaterThanOrEqual(geometry.description.bottom - 1);
      expect(geometry.action.right).toBeCloseTo(geometry.actions.right, 0);
    }
  });
}
