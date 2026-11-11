/// <reference lib="dom" />
/**
 * COR-2360: a Radio's circle sits beside the first line of its label, not the middle of a label
 * that wraps. happy-dom performs no layout, so the geometry is measured in a browser on the
 * `alignment` fixture: a one-line option, an option whose label takes three or more lines at 16rem,
 * and the same option with a description.
 */

import { expect, test, type Page } from '@playwright/test';
import { ALIGNMENT_TOLERANCE, boxOf, firstLineOf } from './first-line-alignment.ts';
import { fixtureRoute } from './overlay-fixture.ts';

const CIRCLE = 18;

async function openAlignment(page: Page): Promise<void> {
  await page.goto(fixtureRoute('radio-group', { fixtureName: 'alignment' }), {
    waitUntil: 'load',
  });
  await page.locator('#alignment-short').waitFor({ state: 'visible' });
}

async function expectBesideFirstLine(page: Page, id: string): Promise<number> {
  const row = page.locator(`.cinder-radio-row:has(#${id})`);
  const control = row.locator('.cinder-radio');
  const label = row.locator('.cinder-radio-row__label');
  const box = await boxOf(control);
  const line = await firstLineOf(label);
  const labelBox = await boxOf(label);
  expect(box.right - box.left).toBeCloseTo(CIRCLE, 0);
  expect(box.bottom - box.top).toBeCloseTo(CIRCLE, 0);
  expect(box.top).toBeGreaterThanOrEqual(line.top - ALIGNMENT_TOLERANCE);
  expect(box.top).toBeLessThan(line.bottom);
  expect(box.bottom).toBeLessThanOrEqual(line.bottom + ALIGNMENT_TOLERANCE);
  expect(box.right).toBeLessThanOrEqual(labelBox.left + ALIGNMENT_TOLERANCE);
  expect(Math.abs(box.center - line.center)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE);
  return line.lines;
}

test.describe('Radio first-line alignment', () => {
  test.beforeEach(async ({ page }) => {
    await openAlignment(page);
  });

  test('a one-line label: the circle centre is the line centre', async ({ page }) => {
    expect(await expectBesideFirstLine(page, 'alignment-short')).toBe(1);
  });

  test('a three-line label: the circle top sits within the first line box', async ({ page }) => {
    expect(await expectBesideFirstLine(page, 'alignment-long')).toBeGreaterThanOrEqual(3);
  });

  test('a described three-line label keeps the circle beside the first line', async ({ page }) => {
    expect(await expectBesideFirstLine(page, 'alignment-described')).toBeGreaterThanOrEqual(3);
  });

  test('a one-line row takes the label line height, as it did when centred', async ({ page }) => {
    const row = await boxOf(page.locator('.cinder-radio-row:has(#alignment-short)'));
    const line = await firstLineOf(
      page.locator('.cinder-radio-row:has(#alignment-short) .cinder-radio-row__label'),
    );
    expect(Math.abs(row.bottom - row.top - line.lineHeight)).toBeLessThanOrEqual(
      ALIGNMENT_TOLERANCE,
    );
  });
});
