/// <reference lib="dom" />
/**
 * COR-2489: an EmptyState row and an ErrorState row place their action alike. In a narrow column
 * (each row's own 28rem container query, COR-2394) each drops its action onto a line of its own,
 * on the same trailing edge; in a wide column each keeps it at the end of the line. happy-dom
 * performs no layout, so it is measured here.
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

for (const width of [320, 1280] as const) {
  test(`the two rows place their action alike at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(fixtureRoute('empty-state', { fixtureName: 'row-action' }), {
      waitUntil: 'load',
    });
    const narrow = page.getByTestId('column-narrow');
    await expect(narrow.getByRole('link', { name: 'Open Health' })).toBeVisible();
    const geometry = await narrow.evaluate((column) => {
      const rect = (selector: string) =>
        column.querySelector(selector)!.getBoundingClientRect().toJSON() as DOMRect;
      return {
        emptyTitle: rect('[data-testid="empty-row"] .cinder-empty-state-title'),
        emptyAction: rect('[data-testid="empty-row"] .cinder-empty-state-action > *'),
        errorText: rect('[data-testid="error-row"] .cinder-error-state-text'),
        errorAction: rect('[data-testid="error-row"] .cinder-error-state-action > *'),
      };
    });
    // Each action is on a line of its own under the words.
    expect(geometry.emptyAction.top).toBeGreaterThanOrEqual(geometry.emptyTitle.bottom - 1);
    expect(geometry.errorAction.top).toBeGreaterThanOrEqual(geometry.errorText.bottom - 1);
    // One trailing edge for both, in one column (COR-2394, the owner's trailing-edge actions).
    expect(geometry.emptyAction.right).toBeCloseTo(geometry.errorAction.right, 0);

    if (width === 1280) {
      // Wide, each action stays at the end of the words' line.
      const wide = await page.getByTestId('column-wide').evaluate((column) => {
        const rect = (selector: string) =>
          column.querySelector(selector)!.getBoundingClientRect().toJSON() as DOMRect;
        return {
          emptyTitle: rect('[data-testid="empty-row"] .cinder-empty-state-title'),
          emptyAction: rect('[data-testid="empty-row"] .cinder-empty-state-action > *'),
        };
      });
      expect(wide.emptyAction.left).toBeGreaterThan(wide.emptyTitle.right);
    }
  });
}
