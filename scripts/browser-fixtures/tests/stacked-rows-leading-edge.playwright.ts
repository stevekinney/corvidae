/// <reference lib="dom" />
/**
 * COR-2760: the rows of a stacked `fit` Table and of a default DescriptionList start on the page's
 * content edge, the same edge as the heading above them, because neither list draws a fill or a
 * frame that needs a gap. Their tint (a current row, a hovered linked row) still starts at least
 * 11px before the text, and nothing clips or covers it.
 */

import { expect, test, type Page } from '@playwright/test';

import { fixtureRoute } from './layout-fixture.ts';

type Tint = {
  /** Left edge of the row's text: the title for the Table, the term for the DescriptionList. */
  text: number;
  /** The tint's box, from the pseudo-element's computed geometry. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Whether `elementFromPoint` one pixel inside the tint's left edge lands on the row. */
  hitsRow: boolean;
  /** Ancestors whose clip rect cuts the tint's box. */
  clippedBy: string[];
  background: string;
};

async function open(page: Page, width: number, colorScheme: 'light' | 'dark'): Promise<void> {
  // The fixture host takes its theme from storage, not from the emulated media query.
  await page.addInitScript(
    (theme) => localStorage.setItem('browser-fixture-theme', theme),
    colorScheme,
  );
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize({ width, height: 900 });
  await page.goto(fixtureRoute('stacked-rows-leading-edge'), { waitUntil: 'load' });
  await expect(page.locator('.cinder-table[data-cinder-stack-card]')).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
    colorScheme,
  );
}

/** Left edge of the first glyph of `selector`'s text, read from a Range over its text. */
async function textLeft(page: Page, selector: string): Promise<number> {
  return page.evaluate((query) => {
    const element = document.querySelector(query);
    if (!element) throw new Error(`no ${query}`);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && (node.textContent ?? '').trim() === '') node = walker.nextNode();
    if (!node) throw new Error(`no text in ${query}`);
    const offset = (node.textContent ?? '').search(/\S/);
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    return range.getBoundingClientRect().left;
  }, selector);
}

/**
 * The tint box of `host`'s `::after`, positioned in `row`'s padding box, with the hit and clip
 * checks: one pixel inside its left edge must land on the row (or the pseudo-element's host), and
 * no ancestor's overflow clip may cut it.
 */
async function tint(page: Page, rowSelector: string, hostSelector: string, textSelector: string) {
  return page.evaluate(
    ([rowQuery, hostQuery, textQuery]) => {
      const row = document.querySelector(rowQuery);
      const host = row?.matches(hostQuery) ? row : row?.querySelector(hostQuery);
      const textElement = row?.querySelector(textQuery);
      if (!row || !host || !textElement) throw new Error(`no ${rowQuery}`);
      const after = getComputedStyle(host, '::after');
      const box = row.getBoundingClientRect();
      const left = box.left + Number.parseFloat(after.left);
      const right = box.right - Number.parseFloat(after.right);
      const top = box.top + Number.parseFloat(after.top);
      const bottom = box.bottom - Number.parseFloat(after.bottom);
      const middle = (top + bottom) / 2;
      const hit = document.elementFromPoint(left + 1, middle);
      const hitsRow = hit !== null && (hit === row || hit === host || row.contains(hit));
      const clippedBy: string[] = [];
      for (let ancestor = row.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const clip = ancestor.getBoundingClientRect();
        const borderLeft = Number.parseFloat(style.borderLeftWidth);
        const borderRight = Number.parseFloat(style.borderRightWidth);
        if (left < clip.left + borderLeft - 0.5 || right > clip.right - borderRight + 0.5) {
          clippedBy.push(`${ancestor.tagName.toLowerCase()}.${ancestor.className}`);
        }
      }
      const range = document.createRange();
      range.selectNodeContents(textElement);
      return {
        text: range.getBoundingClientRect().left,
        left,
        right,
        top,
        bottom,
        hitsRow,
        clippedBy,
        background: after.backgroundColor,
      };
    },
    [rowSelector, hostSelector, textSelector] as const,
  ) as Promise<Tint>;
}

function expectVisibleTint(measured: Tint): void {
  expect(measured.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(measured.text - measured.left).toBeGreaterThanOrEqual(11);
  expect(measured.hitsRow).toBe(true);
  expect(measured.clippedBy).toEqual([]);
}

for (const width of [375, 1280]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(`${width}px, ${colorScheme}`, () => {
      test('stacked table titles and default list terms start on the heading edge', async ({
        page,
      }) => {
        await open(page, width, colorScheme);
        const heading = await textLeft(page, '[data-testid="heading"]');
        const title = await textLeft(
          page,
          '[data-testid="table"] tbody tr:first-child [data-cinder-stack-title]',
        );
        const term = await textLeft(page, '[data-testid="description-list"] dt');
        expect(Math.abs(title - heading)).toBeLessThanOrEqual(1);
        expect(Math.abs(term - heading)).toBeLessThanOrEqual(1);
      });

      test('the current stacked row draws its whole tint at least 11px before its title', async ({
        page,
      }) => {
        await open(page, width, colorScheme);
        expectVisibleTint(
          await tint(
            page,
            '[data-testid="table"] tbody tr[data-cinder-current]',
            'tr',
            '[data-cinder-stack-title]',
          ),
        );
      });

      test('a focused linked stacked row draws its ring inside the tint, where nothing clips it', async ({
        page,
      }) => {
        await open(page, width, colorScheme);
        const link = page.locator('[data-testid="table"] tbody a');
        await link.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(link).toBeFocused();
        const linkedRow = '[data-testid="table"] tbody tr:has(a)';
        const ring = await page.evaluate(
          (query) => getComputedStyle(document.querySelector(query)!, '::after').boxShadow,
          linkedRow,
        );
        // An inset ring lies inside the tint's box, which the clip check below proves is whole.
        expect(ring).toContain('inset');
        const measured = await tint(page, linkedRow, 'tr', '[data-cinder-stack-title]');
        expect(measured.text - measured.left).toBeGreaterThanOrEqual(11);
        expect(measured.clippedBy).toEqual([]);
      });

      test('a hovered linked default list row draws its whole tint at least 11px before its term', async ({
        page,
      }) => {
        await open(page, width, colorScheme);
        // The link's hit area covers the row, so the pointer rests on the row, not on its term.
        await page.locator('[data-testid="description-list"] [data-cinder-linked]').hover();
        expectVisibleTint(
          await tint(
            page,
            '[data-testid="description-list"] [data-cinder-linked]',
            '.cinder-description-list__link',
            'dt',
          ),
        );
      });
    });
  }
}
