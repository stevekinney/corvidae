/// <reference lib="dom" />
/**
 * RestartState's phase cards (owner review, 2026-11-13): every phase draws its card open, and the
 * failed card keeps to the standing preferences: what to check sits flat on the card, not in an
 * inset box; the command has no chip around it; and the copy control is the copy icon at the
 * inline end of the command's row. happy-dom performs no layout, so this is measured in a browser
 * on the phase fixtures, in both themes.
 */

import { THEME_STORAGE_KEY } from '@lostgradient/testing';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

const TOLERANCE = 0.5;

async function openPhase(browser: Browser, phase: string, theme: 'light' | 'dark'): Promise<Page> {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    THEME_STORAGE_KEY,
    theme,
  ] as const);
  const page = await context.newPage();
  await page.goto(fixtureRoute('restart-state', { fixtureName: phase }), { waitUntil: 'load' });
  await page.locator('.cinder-restart-state__card').waitFor();
  return page;
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`RestartState phases, ${theme}`, () => {
    for (const phase of ['restarting', 'reconnecting', 'failed']) {
      test(`${phase}: the card is open and visible`, async ({ browser }) => {
        const page = await openPhase(browser, phase, theme);
        try {
          const card = page.locator('.cinder-restart-state__card');
          await expect(card).toBeVisible();
          await expect(card).toHaveAttribute('data-cinder-phase', phase);
        } finally {
          await page.context().close();
        }
      });
    }

    test('failed: the copy icon ends the command row, and nothing is a box in the card', async ({
      browser,
    }) => {
      const page = await openPhase(browser, 'failed', theme);
      try {
        const row = page.locator('.cinder-restart-state__command-row');
        const copy = row.getByRole('button', { name: 'Copy the command' });
        await expect(copy.locator('svg.lucide-copy')).toBeVisible();
        const rowBox = await row.boundingBox();
        const copyBox = await copy.boundingBox();
        const codeBox = await row.locator('code').boundingBox();
        if (!rowBox || !copyBox || !codeBox) throw new Error('The command row did not lay out.');
        expect(Math.abs(rowBox.x + rowBox.width - (copyBox.x + copyBox.width))).toBeLessThanOrEqual(
          TOLERANCE,
        );
        expect(codeBox.x + codeBox.width).toBeLessThanOrEqual(copyBox.x + TOLERANCE);
        const fills = await page.evaluate(() => {
          const read = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`${selector} is missing.`);
            const style = getComputedStyle(element);
            return {
              background: style.backgroundColor,
              border: style.borderTopWidth,
            };
          };
          return {
            check: read('.cinder-restart-state__check'),
            command: read('.cinder-restart-state__command-text'),
          };
        });
        expect(fills.check.background).toBe('rgba(0, 0, 0, 0)');
        expect(fills.command.background).toBe('rgba(0, 0, 0, 0)');
        expect(fills.command.border).toBe('0px');
      } finally {
        await page.context().close();
      }
    });
  });
}
