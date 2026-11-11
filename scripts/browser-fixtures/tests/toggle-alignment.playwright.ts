/// <reference lib="dom" />
/**
 * COR-2360: a Toggle sits beside the first line of its label, not the middle of a label that
 * wraps. happy-dom performs no layout, so the geometry is measured in a browser on the
 * `alignment` fixture: a one-line label, a label that takes three or more lines at 16rem, and the
 * same label with its description below. The switch's centre is the centre of its hit area, which
 * is also the centre of the painted track.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { ALIGNMENT_TOLERANCE, boxOf, firstLineOf } from './first-line-alignment.ts';
import { fixtureRoute } from './overlay-fixture.ts';

async function openAlignment(page: Page): Promise<void> {
  await page.goto(fixtureRoute('toggle', { fixtureName: 'alignment' }), { waitUntil: 'load' });
  await page.locator('[data-testid="single-line"] button.cinder-toggle').waitFor({
    state: 'visible',
  });
}

async function coarsePage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
    viewport: { width: 390, height: 844 },
  });
  return { page: await context.newPage(), close: () => context.close() };
}

// The switch's centre meets the centre of the label's first line, and the switch is beside the
// label, not above it. Returns how many lines the label takes.
async function expectBesideFirstLine(page: Page, testId: string): Promise<number> {
  const root = page.locator(`[data-testid="${testId}"]`);
  const box = await boxOf(root.locator('button.cinder-toggle'));
  const label = root.locator('.cinder-toggle-field__label');
  const line = await firstLineOf(label);
  const labelBox = await boxOf(label);
  expect(box.right).toBeLessThanOrEqual(labelBox.left + ALIGNMENT_TOLERANCE);
  expect(Math.abs(box.center - line.center)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE);
  return line.lines;
}

test.describe('Toggle first-line alignment', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ media: 'screen' });
    await openAlignment(page);
  });

  test('a one-line label: the switch centre is the line centre', async ({ page }) => {
    expect(await expectBesideFirstLine(page, 'single-line')).toBe(1);
  });

  test('a one-line field is as tall as the switch hit area, as it was when centred', async ({
    page,
  }) => {
    const field = await boxOf(page.locator('[data-testid="single-line"] .cinder-toggle-field'));
    const button = await boxOf(page.locator('[data-testid="single-line"] button.cinder-toggle'));
    expect(field.bottom - field.top).toBeCloseTo(button.bottom - button.top, 0);
  });

  test('a three-line label: the switch sits beside the first line', async ({ page }) => {
    expect(await expectBesideFirstLine(page, 'long-label')).toBeGreaterThanOrEqual(3);
  });

  test('a three-line label with its description below: the switch sits beside the first line', async ({
    page,
  }) => {
    expect(await expectBesideFirstLine(page, 'below')).toBeGreaterThanOrEqual(3);
  });
});

test.describe('Toggle first-line alignment, coarse pointer', () => {
  test('the 44px hit area keeps the switch beside the first line of a three-line label', async ({
    browser,
  }) => {
    const { page, close } = await coarsePage(browser);
    try {
      await openAlignment(page);
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
      expect(await expectBesideFirstLine(page, 'long-label')).toBeGreaterThanOrEqual(3);
      expect(await expectBesideFirstLine(page, 'single-line')).toBe(1);
    } finally {
      await close();
    }
  });
});
