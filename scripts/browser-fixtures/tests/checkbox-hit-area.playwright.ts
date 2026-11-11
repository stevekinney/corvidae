/// <reference lib="dom" />
/**
 * COR-2316: a Checkbox's hit area is at least 24px, and at least 44px under a coarse pointer,
 * while the painted box stays 18px (20px for the round task variant).
 *
 * happy-dom performs no layout, so the hit box is measured in a browser on the `alignment`
 * fixture. The row around the box is the hit area, so its box is measured, and a press on its
 * padding, outside the painted box, is dispatched to prove the padding answers a press. A coarse
 * pointer is resolved by Chromium from the context's `hasTouch` and `isMobile`, not from
 * `page.emulateMedia`.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { boxOf } from './first-line-alignment.ts';
import { fixtureRoute } from './overlay-fixture.ts';

const BOX = 18;
const TASK_BOX = 20;
const FINE_HIT = 24;
const COARSE_HIT = 44;

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

// The hit box (the row) and the painted box (the input).
async function measure(page: Page, testId: string) {
  const root = page.locator(`[data-testid="${testId}"]`);
  const hit = await boxOf(root.locator('.cinder-checkbox-row'));
  const painted = await boxOf(root.locator('.cinder-checkbox'));
  return { hit, painted };
}

test.describe('Checkbox hit area, fine pointer', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ media: 'screen' });
    await openAlignment(page);
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(false);
  });

  test('the hit box is at least 24px and the painted box stays 18px', async ({ page }) => {
    const { hit, painted } = await measure(page, 'single-line');
    expect(hit.right - hit.left).toBeGreaterThanOrEqual(FINE_HIT);
    expect(hit.bottom - hit.top).toBeGreaterThanOrEqual(FINE_HIT);
    expect(painted.right - painted.left).toBeCloseTo(BOX, 0);
    expect(painted.bottom - painted.top).toBeCloseTo(BOX, 0);
  });

  test('the hit box of the task variant is at least 24px and its painted box is 20px', async ({
    page,
  }) => {
    const { hit, painted } = await measure(page, 'task-long-label');
    expect(hit.right - hit.left).toBeGreaterThanOrEqual(FINE_HIT);
    expect(hit.bottom - hit.top).toBeGreaterThanOrEqual(FINE_HIT);
    expect(painted.right - painted.left).toBeCloseTo(TASK_BOX, 0);
    expect(painted.bottom - painted.top).toBeCloseTo(TASK_BOX, 0);
  });

  test('the hit box is centred on the painted box', async ({ page }) => {
    const { hit, painted } = await measure(page, 'single-line');
    expect(Math.abs(hit.center - painted.center)).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs((hit.left + hit.right) / 2 - (painted.left + painted.right) / 2),
    ).toBeLessThanOrEqual(0.5);
  });

  test('a bare box keeps taking only its own height in layout', async ({ page }) => {
    const root = page.locator('[data-testid="bare"]');
    const field = await boxOf(root.locator('.cinder-checkbox-field'));
    expect(field.bottom - field.top).toBeCloseTo(BOX, 0);
  });

  test('a press on the row outside the painted box toggles the checkbox', async ({ page }) => {
    const root = page.locator('[data-testid="single-line"]');
    const input = root.locator('.cinder-checkbox');
    await expect(input).not.toBeChecked();
    await root.locator('.cinder-checkbox-row').click({ position: { x: 1, y: 1 } });
    await expect(input).toBeChecked();
  });
});

test.describe('Checkbox hit area, coarse pointer', () => {
  test('the hit box is at least 44px and the painted box stays 18px', async ({ browser }) => {
    const { page, close } = await coarsePage(browser);
    try {
      await openAlignment(page);
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
      for (const testId of ['single-line', 'long-label', 'bare']) {
        const { hit, painted } = await measure(page, testId);
        expect(hit.right - hit.left, `${testId} hit width`).toBeGreaterThanOrEqual(COARSE_HIT);
        expect(hit.bottom - hit.top, `${testId} hit height`).toBeGreaterThanOrEqual(COARSE_HIT);
        expect(painted.right - painted.left, `${testId} painted width`).toBeCloseTo(BOX, 0);
        expect(painted.bottom - painted.top, `${testId} painted height`).toBeCloseTo(BOX, 0);
      }
    } finally {
      await close();
    }
  });

  test('the task variant is at least 44px with a 20px painted box', async ({ browser }) => {
    const { page, close } = await coarsePage(browser);
    try {
      await openAlignment(page);
      const { hit, painted } = await measure(page, 'task-long-label');
      expect(hit.right - hit.left).toBeGreaterThanOrEqual(COARSE_HIT);
      expect(hit.bottom - hit.top).toBeGreaterThanOrEqual(COARSE_HIT);
      expect(painted.right - painted.left).toBeCloseTo(TASK_BOX, 0);
    } finally {
      await close();
    }
  });

  test('a press on the row outside the painted box toggles the checkbox', async ({ browser }) => {
    const { page, close } = await coarsePage(browser);
    try {
      await openAlignment(page);
      const root = page.locator('[data-testid="bare"]');
      const input = root.locator('.cinder-checkbox');
      await expect(input).not.toBeChecked();
      await root.locator('.cinder-checkbox-row').click({ position: { x: 1, y: 1 } });
      await expect(input).toBeChecked();
    } finally {
      await close();
    }
  });
});
