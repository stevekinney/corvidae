/// <reference lib="dom" />
/**
 * PhoneInput's country control (owner review, 2026-11-13): the closed control shows the region
 * code and the dial code ("US +1") and is as wide as that, not a fixed 7 to 10rem column; the
 * number takes the rest of the line; the two read as one field of one height, joined at a single
 * seam; and a narrow container keeps them on one line. happy-dom performs no layout, so the
 * geometry is measured in a browser on the `sizing` fixture, in both themes.
 */

import { THEME_STORAGE_KEY } from '@lostgradient/testing';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

const TOLERANCE = 0.5;

type Rect = { left: number; right: number; top: number; bottom: number; width: number };

async function openSizing(browser: Browser, theme: 'light' | 'dark'): Promise<Page> {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 1000 },
  });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    THEME_STORAGE_KEY,
    theme,
  ] as const);
  const page = await context.newPage();
  await page.goto(fixtureRoute('phone-input', { fixtureName: 'sizing' }), { waitUntil: 'load' });
  await page.locator('[data-testid="rtl"] select').waitFor();
  return page;
}

async function rectOf(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
    };
  });
}

type Parts = { group: Rect; select: Rect; summary: Rect; national: Rect; text: Rect };

async function partsOf(page: Page, testId: string): Promise<Parts> {
  const cell = page.locator(`[data-testid="${testId}"]`);
  const summary = cell.locator('.cinder-phone-input__country-summary');
  return {
    group: await rectOf(cell.locator('.cinder-phone-input')),
    select: await rectOf(cell.locator('select')),
    summary: await rectOf(summary),
    national: await rectOf(cell.locator('input[type="tel"]')),
    // The summary's own text, measured as a range so its padding is left out.
    text: await summary.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const box = range.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
      };
    }),
  };
}

const REM = 16;

for (const theme of ['light', 'dark'] as const) {
  test.describe(`PhoneInput country control, ${theme}`, () => {
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      page = await openSizing(browser, theme);
    });

    test.afterAll(async () => {
      await page.context().close();
    });

    test('the closed control shows the region and dial code, and hugs them', async () => {
      const cell = page.locator('[data-testid="default"]');
      await expect(cell.locator('.cinder-phone-input__country-summary')).toHaveText('US +1');
      const parts = await partsOf(page, 'default');
      expect(parts.select.width).toBeGreaterThanOrEqual(4.5 * REM - TOLERANCE);
      expect(parts.select.width).toBeLessThanOrEqual(5.5 * REM + TOLERANCE);
      // The text sits inside the control, clear of the chevron's 30px at the end.
      expect(parts.text.left).toBeGreaterThanOrEqual(parts.select.left + 12 - TOLERANCE);
      expect(parts.text.right).toBeLessThanOrEqual(parts.select.right - 30 - TOLERANCE);
    });

    test('a longer dial code widens the control by its own text, never to a fixed column', async () => {
      const short = await partsOf(page, 'default');
      for (const testId of ['long-code', 'american-samoa']) {
        const parts = await partsOf(page, testId);
        expect(
          Math.abs(parts.select.width - parts.text.width - (short.select.width - short.text.width)),
          testId,
        ).toBeLessThanOrEqual(TOLERANCE + 1);
        expect(parts.select.width, testId).toBeLessThan(10 * REM);
      }
    });

    test('the number takes the rest of the line, at one height, joined at one seam', async () => {
      for (const testId of ['default', 'disabled', 'invalid', 'narrow']) {
        const parts = await partsOf(page, testId);
        expect(Math.abs(parts.national.right - parts.group.right), testId).toBeLessThanOrEqual(
          TOLERANCE,
        );
        // The national input's border box overlaps the select's end border by its 1px border.
        expect(
          Math.abs(parts.national.left - (parts.select.right - 1)),
          testId,
        ).toBeLessThanOrEqual(TOLERANCE);
        expect(Math.abs(parts.national.top - parts.select.top), testId).toBeLessThanOrEqual(
          TOLERANCE,
        );
        expect(Math.abs(parts.national.bottom - parts.select.bottom), testId).toBeLessThanOrEqual(
          TOLERANCE,
        );
      }
    });

    test('a narrow container keeps the two on one line', async () => {
      const parts = await partsOf(page, 'narrow');
      expect(Math.abs(parts.national.top - parts.select.top)).toBeLessThanOrEqual(TOLERANCE);
      expect(parts.national.width).toBeGreaterThan(parts.select.width);
    });

    test('right to left puts the country control at the inline start, on the right', async () => {
      const parts = await partsOf(page, 'rtl');
      expect(Math.abs(parts.select.right - parts.group.right)).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(parts.national.right - (parts.select.left + 1))).toBeLessThanOrEqual(
        TOLERANCE,
      );
      expect(parts.text.right).toBeLessThanOrEqual(parts.select.right - 12 + TOLERANCE);
      expect(parts.text.left).toBeGreaterThanOrEqual(parts.select.left + 30 - TOLERANCE);
    });

    test('the country control is still named by the country, not the code', async () => {
      const select = page.locator('[data-testid="default"] select');
      await expect(select).toHaveAccessibleName('Phone Country: United States, +1');
      const options = await select.locator('option').allTextContents();
      expect(options).toContain('Finland +358');
    });

    test('typing a country name picks that country, and the closed control follows', async () => {
      const cell = page.locator('[data-testid="american-samoa"]');
      await cell.locator('select').focus();
      await page.keyboard.type('Finland');
      await expect(cell.locator('select')).toHaveValue('FI');
      await expect(cell.locator('.cinder-phone-input__country-summary')).toHaveText('FI +358');
    });
  });
}
