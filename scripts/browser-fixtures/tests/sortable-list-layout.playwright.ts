import { expect, test } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';
const SORTABLE_ROUTE = fixtureRoute('sortable-list');
test.describe('SortableList resting layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(SORTABLE_ROUTE, { waitUntil: 'load' });
  });
  test('keeps each item label and trailing drag handle in one centered row', async ({ page }) => {
    const row = page.locator('[data-sortable-row]').filter({ hasText: 'Write release notes' });
    const label = row.getByText('Write release notes', { exact: true });
    const handle = row.getByRole('button', { name: 'Reorder Write release notes' });
    const [labelBox, handleBox] = await Promise.all([label.boundingBox(), handle.boundingBox()]);
    expect(labelBox).not.toBeNull();
    expect(handleBox).not.toBeNull();
    expect(
      Math.abs(labelBox!.y + labelBox!.height / 2 - (handleBox!.y + handleBox!.height / 2)),
    ).toBeLessThanOrEqual(0.5);
    expect(handleBox!.x).toBeGreaterThanOrEqual(labelBox!.x + labelBox!.width);
  });
  test('does not override Kanban card alignment through the shared sortable item', async ({
    page,
  }) => {
    const card = page.locator('.cinder-kanban-board__card').first();
    await expect(card).toHaveCSS('align-items', 'start');
    await expect(card.locator('.cinder-sortable-list__item-content')).toHaveCount(0);
  });
});
