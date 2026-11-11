/// <reference lib="dom" />
/**
 * COR-2360: a StackedListItem row that leads with a checkbox sits the box beside the first line of
 * the title, whether the title takes one line or clamps to two. happy-dom performs no layout, so
 * the geometry is measured in a browser on the `leading-checkbox` fixture.
 */

import { expect, test, type Page } from '@playwright/test';
import { ALIGNMENT_TOLERANCE, boxOf, firstLineOf } from './first-line-alignment.ts';
import { fixtureRoute } from './overlay-fixture.ts';

const TASK_BOX = 20;

async function openRows(page: Page): Promise<void> {
  await page.goto(fixtureRoute('stacked-list-item', { fixtureName: 'leading-checkbox' }), {
    waitUntil: 'load',
  });
  await page.locator('[data-testid="rows"] .cinder-checkbox').first().waitFor({ state: 'visible' });
}

// The box's centre meets the centre of the title's first line, and the box is beside the title.
// Returns how many lines the title takes.
async function expectBesideFirstLine(page: Page, index: number): Promise<number> {
  const row = page.locator('[data-testid="rows"] .cinder-stacked-list-item').nth(index);
  const box = await boxOf(row.locator('.cinder-checkbox'));
  const title = row.locator('.cinder-stacked-list-item__title');
  const line = await firstLineOf(title);
  const titleBox = await boxOf(title);
  expect(box.right - box.left).toBeCloseTo(TASK_BOX, 0);
  expect(box.right).toBeLessThanOrEqual(titleBox.left + ALIGNMENT_TOLERANCE);
  expect(Math.abs(box.center - line.center)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE);
  return line.lines;
}

test.describe('StackedListItem leading checkbox', () => {
  test.beforeEach(async ({ page }) => {
    await openRows(page);
  });

  test('a one-line title: the box centre is the title line centre', async ({ page }) => {
    expect(await expectBesideFirstLine(page, 0)).toBe(1);
  });

  test('a title that clamps to two lines: the box sits beside the first line', async ({ page }) => {
    expect(await expectBesideFirstLine(page, 1)).toBe(2);
  });
});
