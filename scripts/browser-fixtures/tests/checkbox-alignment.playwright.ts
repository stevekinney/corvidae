/// <reference lib="dom" />
/**
 * COR-2360: a Checkbox sits beside the first line of its label, not the middle of a label that
 * wraps. happy-dom performs no layout, so the geometry is measured in a browser on the
 * `alignment` fixture: a one-line label, a label that takes three or more lines at 16rem, the
 * round task variant, a described field and a bare box.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { ALIGNMENT_TOLERANCE, boxOf, firstLineOf } from './first-line-alignment.ts';
import { fixtureRoute } from './overlay-fixture.ts';

const BOX = 18;
const TASK_BOX = 20;

async function openAlignment(page: Page): Promise<void> {
  await page.goto(fixtureRoute('checkbox', { fixtureName: 'alignment' }), { waitUntil: 'load' });
  await page.locator('[data-testid="single-line"] .cinder-checkbox').waitFor({ state: 'visible' });
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

function field(page: Page, testId: string) {
  return {
    control: page.locator(`[data-testid="${testId}"] .cinder-checkbox`),
    label: page.locator(`[data-testid="${testId}"] .cinder-form-field__label`),
  };
}

// The box's top sits inside the label's first line box, the box is beside the label and not above
// it, and its centre meets the line's centre.
async function expectBesideFirstLine(page: Page, testId: string, size: number): Promise<void> {
  const { control, label } = field(page, testId);
  const box = await boxOf(control);
  const line = await firstLineOf(label);
  const labelBox = await boxOf(label);
  expect(box.right - box.left).toBeCloseTo(size, 0);
  expect(box.bottom - box.top).toBeCloseTo(size, 0);
  expect(box.top).toBeGreaterThanOrEqual(line.top - ALIGNMENT_TOLERANCE);
  expect(box.top).toBeLessThan(line.bottom);
  expect(box.bottom).toBeLessThanOrEqual(line.bottom + ALIGNMENT_TOLERANCE);
  expect(box.right).toBeLessThanOrEqual(labelBox.left + ALIGNMENT_TOLERANCE);
  expect(Math.abs(box.center - line.center)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE);
}

test.describe('Checkbox first-line alignment', () => {
  test.beforeEach(async ({ page }) => {
    await openAlignment(page);
  });

  test('a one-line label: the box centre is the line centre', async ({ page }) => {
    const { label } = field(page, 'single-line');
    expect((await firstLineOf(label)).lines).toBe(1);
    await expectBesideFirstLine(page, 'single-line', BOX);
  });

  test('a three-line label: the box top sits within the first line box', async ({ page }) => {
    const { label } = field(page, 'long-label');
    expect((await firstLineOf(label)).lines).toBeGreaterThanOrEqual(3);
    await expectBesideFirstLine(page, 'long-label', BOX);
  });

  test('the task variant is a 20px circle beside the first line of a three-line label', async ({
    page,
  }) => {
    const { control, label } = field(page, 'task-long-label');
    expect((await firstLineOf(label)).lines).toBeGreaterThanOrEqual(3);
    await expectBesideFirstLine(page, 'task-long-label', TASK_BOX);
    const radius = await control.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
    );
    expect(radius).toBeGreaterThanOrEqual(TASK_BOX / 2);
  });

  test('a described three-line label keeps the box beside the first line', async ({ page }) => {
    const { label } = field(page, 'described');
    expect((await firstLineOf(label)).lines).toBeGreaterThanOrEqual(3);
    await expectBesideFirstLine(page, 'described', BOX);
  });

  test('a one-line and a three-line label put the box at the same distance from the top', async ({
    page,
  }) => {
    const single = await boxOf(field(page, 'single-line').control);
    const singleTop = single.top - (await boxOf(page.locator('[data-testid="single-line"]'))).top;
    const long = await boxOf(field(page, 'long-label').control);
    const longTop = long.top - (await boxOf(page.locator('[data-testid="long-label"]'))).top;
    expect(Math.abs(singleTop - longTop)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE);
  });

  test('a bare box takes exactly its own height in layout', async ({ page }) => {
    const bare = page.locator('[data-testid="bare"] .cinder-checkbox-field');
    const box = await boxOf(page.locator('[data-testid="bare"] .cinder-checkbox'));
    const fieldBox = await boxOf(bare);
    expect(fieldBox.bottom - fieldBox.top).toBeCloseTo(box.bottom - box.top, 0);
  });
});

test.describe('Checkbox first-line alignment, coarse pointer', () => {
  test('a three-line label: the 44px hit area does not move the box off the first line', async ({
    browser,
  }) => {
    const { page, close } = await coarsePage(browser);
    try {
      await openAlignment(page);
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
      await expectBesideFirstLine(page, 'long-label', BOX);
    } finally {
      await close();
    }
  });
});
