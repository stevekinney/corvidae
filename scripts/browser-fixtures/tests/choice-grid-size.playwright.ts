/// <reference lib="dom" />
/**
 * Regression coverage for COR-330: ChoiceGrid/ChoiceGridItem's compact
 * `size="sm"`.
 *
 * happy-dom (the unit-test DOM) performs no real layout, so the parts of
 * this contract that depend on actual box geometry and CSS media query
 * evaluation — the fine-vs-coarse pointer block-size split, the 44×44
 * touch-target floor, and "states never change dimensions" — need a real
 * browser. `choice-grid.svelte` (the shared fixture) provides three
 * `size="sm"` sections: a single-select, a multi-select, and one exercising
 * every item state at the same size.
 */

import { expect, test, type Page } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

const CHOICE_GRID_ROUTE = fixtureRoute('choice-grid');

async function cellBox(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} has no layout box`);
  return box;
}

test.describe('ChoiceGrid compact size', () => {
  test('fine pointer: size="sm" cells match the button sm block-size', async ({ page }) => {
    await page.emulateMedia({ media: 'screen' });
    await page.goto(CHOICE_GRID_ROUTE, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const box = await cellBox(page, '#example-mount-compact-single .cinder-choice-grid-item');
    // Read the button height the cell follows rather than restating it, so a
    // retune of `--cinder-button-height-sm` cannot strand this assertion.
    const buttonSm = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.blockSize = 'var(--cinder-button-height-sm)';
      document.body.append(probe);
      const height = probe.getBoundingClientRect().height;
      probe.remove();
      return height;
    });
    expect(buttonSm).toBeGreaterThan(0);
    // A small tolerance for sub-pixel layout rounding.
    expect(Math.abs(box.height - buttonSm)).toBeLessThanOrEqual(2);
  });

  test('coarse pointer: size="sm" cells floor at a 44×44 touch target', async ({ browser }) => {
    // Chromium resolves `(pointer: coarse)` from the context's touch/mobile
    // emulation at context-creation time, not from `page.emulateMedia`
    // (which only covers the media features it lists explicitly). A
    // dedicated touch-capable context is the reliable way to force it.
    const context = await browser.newContext({ hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      await page.goto(CHOICE_GRID_ROUTE, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
      const box = await cellBox(page, '#example-mount-compact-single .cinder-choice-grid-item');
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    } finally {
      await context.close();
    }
  });

  test('states do not change cell dimensions at size="sm"', async ({ page }) => {
    await page.goto(CHOICE_GRID_ROUTE, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const states = page.locator('#example-mount-compact-states .cinder-choice-grid-item');
    const boxes = await states.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    expect(boxes.length).toBe(4);
    const [neutral, correct, incorrect, disabled] = boxes;
    for (const box of [correct, incorrect, disabled]) {
      expect(box!.height).toBeCloseTo(neutral!.height, 0);
      expect(box!.width).toBeCloseTo(neutral!.width, 0);
    }
  });

  test('multi-select compact cells keep roving keyboard navigation and toggle selection', async ({
    page,
  }) => {
    await page.goto(CHOICE_GRID_ROUTE, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const scope = page.locator('#example-mount-compact-multi');
    const first = scope.locator('.cinder-choice-grid-item').first();
    await first.focus();
    await expect(first).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const second = scope.locator('.cinder-choice-grid-item').nth(1);
    await expect(second).toBeFocused();
    await page.keyboard.press(' ');
    await expect(second).toHaveAttribute('data-cinder-selected', '');
  });
});
