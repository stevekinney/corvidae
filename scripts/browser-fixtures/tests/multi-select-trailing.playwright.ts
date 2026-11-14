/// <reference lib="dom" />
/**
 * The trailing controls of a closed MultiSelect (owner review, 2026-11-13): the clear x sits
 * just before the chevron, centred on the field, and the chevron is the last thing at the inline
 * end, at the same inset as the chevron of every other Cinder select (Select, in both
 * presentations, and Combobox). happy-dom performs no layout, so the geometry is measured in a
 * browser on the `trailing` fixture, at every size, in both themes and in a right-to-left field.
 */

import { THEME_STORAGE_KEY } from '@lostgradient/testing';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

/** Centring and inset tolerance: half a pixel, the brief's bound. */
const TOLERANCE = 0.5;
/** The gap between the clear button's box and the chevron's box: the 4px icon gap. */
const ICON_GAP = 4;

type Rect = { left: number; right: number; top: number; bottom: number };
type Theme = 'light' | 'dark';

async function openTrailing(browser: Browser, theme: Theme): Promise<Page> {
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
  await page.goto(fixtureRoute('multi-select', { fixtureName: 'trailing' }), { waitUntil: 'load' });
  await page.locator('[data-testid="rtl"] .cinder-multi-select__trigger').waitFor();
  return page;
}

async function rectOf(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  });
}

const middle = (rect: Rect): number => (rect.top + rect.bottom) / 2;

/** The chevron's distance from the field's outer edge on the side the field ends on. */
function endInset(frame: Rect, chevron: Rect, rtl: boolean): number {
  return rtl ? chevron.left - frame.left : frame.right - chevron.right;
}

type Parts = { frame: Rect; chevron: Rect; clear?: Rect; glyph?: Rect; summary?: Rect };

async function multiSelectParts(cell: Locator): Promise<Parts> {
  const frame = await rectOf(cell.locator('.cinder-multi-select__trigger'));
  const chevron = await rectOf(cell.locator('.cinder-multi-select__chevron'));
  const summary = await rectOf(cell.locator('.cinder-multi-select__summary'));
  const clearButton = cell.locator('.cinder-multi-select__clear');
  if ((await clearButton.count()) === 0) return { frame, chevron, summary };
  return {
    frame,
    chevron,
    summary,
    clear: await rectOf(clearButton),
    glyph: await rectOf(clearButton.locator('svg')),
  };
}

const sizes = ['sm', 'md', 'lg'] as const;

for (const theme of ['light', 'dark'] as const) {
  test.describe(`MultiSelect trailing controls, ${theme}`, () => {
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      page = await openTrailing(browser, theme);
    });

    test.afterAll(async () => {
      await page.context().close();
    });

    for (const size of sizes) {
      test(`${size}: every select puts its chevron at the same inset, centred`, async () => {
        const row = page.locator(`[data-testid="size-${size}"]`);
        const reference = await rectOf(row.locator('[data-testid="select"] .cinder-select'));
        const referenceChevron = await rectOf(
          row.locator('[data-testid="select"] .cinder-select-field__chevron'),
        );
        const inset = endInset(reference, referenceChevron, false);
        const others: Array<[string, string, string]> = [
          ['select-listbox', '.cinder-select', '.cinder-select-field__chevron'],
          ['combobox', '.cinder-combobox__input', '.cinder-combobox__chevron'],
          ['none', '.cinder-multi-select__trigger', '.cinder-multi-select__chevron'],
          ['one', '.cinder-multi-select__trigger', '.cinder-multi-select__chevron'],
          ['many', '.cinder-multi-select__trigger', '.cinder-multi-select__chevron'],
        ];
        for (const [testId, frameSelector, chevronSelector] of others) {
          const cell = row.locator(`[data-testid="${testId}"]`);
          const frame = await rectOf(cell.locator(frameSelector));
          const chevron = await rectOf(cell.locator(chevronSelector));
          expect(Math.abs(endInset(frame, chevron, false) - inset), testId).toBeLessThanOrEqual(
            TOLERANCE,
          );
          expect(chevron.right - chevron.left, `${testId} chevron width`).toBeCloseTo(
            referenceChevron.right - referenceChevron.left,
            1,
          );
          expect(Math.abs(middle(chevron) - middle(frame)), testId).toBeLessThanOrEqual(TOLERANCE);
        }
      });

      test(`${size}: the clear x is centred and sits one icon gap before the chevron`, async () => {
        for (const testId of ['one', 'many']) {
          const parts = await multiSelectParts(
            page.locator(`[data-testid="size-${size}"] [data-testid="${testId}"]`),
          );
          if (!parts.clear || !parts.glyph || !parts.summary) throw new Error('No clear button.');
          expect(Math.abs(middle(parts.glyph) - middle(parts.frame))).toBeLessThanOrEqual(
            TOLERANCE,
          );
          expect(Math.abs(middle(parts.clear) - middle(parts.frame))).toBeLessThanOrEqual(
            TOLERANCE,
          );
          expect(Math.abs(parts.chevron.left - parts.clear.right - ICON_GAP)).toBeLessThanOrEqual(
            TOLERANCE,
          );
          expect(parts.summary.right).toBeLessThanOrEqual(parts.clear.left + TOLERANCE);
        }
      });
    }

    test('the count is the summary text, with no separate chip', async () => {
      const many = page.locator('[data-testid="size-md"] [data-testid="many"]');
      await expect(many.locator('.cinder-multi-select__summary')).toHaveText('3 selected');
      await expect(many.locator('.cinder-multi-select__count')).toHaveCount(0);
    });

    test('with no x to show, the chevron keeps its inset and nothing is reserved', async () => {
      const md = await multiSelectParts(
        page.locator('[data-testid="size-md"] [data-testid="one"]'),
      );
      const mdInset = endInset(md.frame, md.chevron, false);
      const none = await multiSelectParts(
        page.locator('[data-testid="size-md"] [data-testid="none"]'),
      );
      for (const testId of ['disabled', 'read-only']) {
        const parts = await multiSelectParts(page.locator(`[data-testid="${testId}"]`));
        expect(parts.clear, testId).toBeUndefined();
        expect(Math.abs(endInset(parts.frame, parts.chevron, false) - mdInset)).toBeLessThanOrEqual(
          TOLERANCE,
        );
        if (!parts.summary || !none.summary) throw new Error('No summary.');
        // The summary runs as close to the chevron as it does in an empty field: no x slot.
        expect(
          Math.abs(
            parts.chevron.left - parts.summary.right - (none.chevron.left - none.summary.right),
          ),
          testId,
        ).toBeLessThanOrEqual(TOLERANCE);
      }
    });

    test('invalid keeps the same trailing layout', async () => {
      const md = await multiSelectParts(
        page.locator('[data-testid="size-md"] [data-testid="one"]'),
      );
      const invalid = await multiSelectParts(page.locator('[data-testid="invalid"]'));
      if (!invalid.clear || !md.clear) throw new Error('No clear button.');
      expect(
        Math.abs(md.frame.right - md.clear.right - (invalid.frame.right - invalid.clear.right)),
      ).toBeLessThanOrEqual(TOLERANCE);
    });

    test('a long placeholder truncates before the chevron', async () => {
      const parts = await multiSelectParts(page.locator('[data-testid="long"]'));
      if (!parts.summary) throw new Error('No summary.');
      expect(parts.summary.right).toBeLessThanOrEqual(parts.chevron.left + TOLERANCE);
      expect(parts.frame.bottom - parts.frame.top).toBeLessThan(48);
    });

    test('right to left mirrors the order: chevron first from the inline end, then the x', async () => {
      const parts = await multiSelectParts(page.locator('[data-testid="rtl"]'));
      const select = page.locator('[data-testid="rtl-select"]');
      const selectInset = endInset(
        await rectOf(select.locator('.cinder-select')),
        await rectOf(select.locator('.cinder-select-field__chevron')),
        true,
      );
      if (!parts.clear || !parts.glyph || !parts.summary) throw new Error('No clear button.');
      expect(
        Math.abs(endInset(parts.frame, parts.chevron, true) - selectInset),
      ).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(parts.clear.left - parts.chevron.right - ICON_GAP)).toBeLessThanOrEqual(
        TOLERANCE,
      );
      expect(parts.summary.left).toBeGreaterThanOrEqual(parts.clear.right - TOLERANCE);
      expect(Math.abs(middle(parts.glyph) - middle(parts.frame))).toBeLessThanOrEqual(TOLERANCE);
    });
  });
}

test.describe('MultiSelect trailing controls, pointer', () => {
  test('clicking the chevron opens the menu and keeps the selection', async ({ browser }) => {
    const page = await openTrailing(browser, 'light');
    try {
      const cell = page.locator('[data-testid="size-md"] [data-testid="many"]');
      const chevron = await rectOf(cell.locator('.cinder-multi-select__chevron'));
      await page.mouse.click((chevron.left + chevron.right) / 2, middle(chevron));
      await expect(cell.locator('.cinder-multi-select__trigger')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(cell.locator('.cinder-multi-select__summary')).toHaveText('3 selected');
    } finally {
      await page.context().close();
    }
  });

  test('clicking the x clears the selection and leaves the menu closed', async ({ browser }) => {
    const page = await openTrailing(browser, 'light');
    try {
      const cell = page.locator('[data-testid="size-md"] [data-testid="many"]');
      await cell.locator('.cinder-multi-select__clear').click();
      await expect(cell.locator('.cinder-multi-select__summary')).toHaveText('Select options');
      await expect(cell.locator('.cinder-multi-select__trigger')).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    } finally {
      await page.context().close();
    }
  });
});
