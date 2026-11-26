/// <reference lib="dom" />
/**
 * COR-2769: a `fit` Table whose short columns set `sizing="content"` gives them the width of their
 * content and the rest to the prose column marked `sizing="fill"`. Measured on the `fitColumns`
 * section of the Table fixture, shaped like the Temporal UI's Connection checks table.
 */

import { expect, test, type Page } from '@playwright/test';

import { fixtureRoute } from './layout-fixture.ts';

type CellMeasure = {
  /** Lines the cell's text occupies. */
  lines: number;
  /** The cell's content-box width less the width of its widest line of text. */
  unused: number;
  /** The width the cell's content needs on one line, plus its inline padding. */
  needed: number;
  /** The cell's border-box width. */
  width: number;
};

async function open(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${fixtureRoute('table')}&fitColumns=1`, { waitUntil: 'load' });
  await expect(page.getByTestId('fit-columns').locator('table')).toBeVisible();
}

/** Every body row of the table in `testId`, as one measure per cell. */
async function measureRows(page: Page, testId: string): Promise<CellMeasure[][]> {
  return page.evaluate((id) => {
    // A text node's range has one client rect per line it occupies. Element boxes (a badge's
    // frame) are left out, so a badge's padding never reads as a second line.
    const textRects = (cell: Element): DOMRect[][] => {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      const perNode: DOMRect[][] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.textContent ?? '').trim() === '') continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        perNode.push(Array.from(range.getClientRects()).filter((rect) => rect.width > 0));
      }
      return perNode;
    };
    return Array.from(document.querySelectorAll(`[data-testid="${id}"] tbody tr`), (row) =>
      Array.from(row.children, (cell) => {
        const style = getComputedStyle(cell);
        const padding =
          Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
        const perNode = textRects(cell);
        const lines = Math.max(0, ...perNode.map((rects) => rects.length));
        const textWidth = Math.max(0, ...perNode.flat().map((rect) => rect.width));
        // The width the content asks for on one line: measured on a nowrap clone off the page.
        const clone = cell.cloneNode(true) as HTMLElement;
        clone.style.cssText =
          'position:absolute;visibility:hidden;inline-size:max-content;white-space:nowrap;display:block';
        cell.parentElement?.append(clone);
        const needed = clone.getBoundingClientRect().width;
        clone.remove();
        const width = cell.getBoundingClientRect().width;
        return { lines, unused: width - padding - textWidth, needed, width };
      }),
    );
  }, testId);
}

for (const width of [1280, 1024]) {
  test(`at ${width}px no cell wraps while another column in its row has room to spare`, async ({
    page,
  }) => {
    await open(page, width);
    for (const row of await measureRows(page, 'fit-columns')) {
      for (const [index, cell] of row.entries()) {
        if (cell.lines <= 1) continue;
        const roomElsewhere = row.filter(
          (other, otherIndex) => otherIndex !== index && other.unused >= 80,
        );
        expect(roomElsewhere).toEqual([]);
      }
    }
  });

  test(`at ${width}px the Result column is as wide as its widest cell`, async ({ page }) => {
    await open(page, width);
    const rows = await measureRows(page, 'fit-columns');
    const result = rows.map((row) => row[1]!);
    const widest = Math.max(...result.map((cell) => cell.needed));
    for (const cell of result) {
      expect(cell.lines).toBe(1);
      expect(Math.abs(cell.width - widest)).toBeLessThanOrEqual(8);
    }
  });

  test(`at ${width}px no fit table scrolls sideways, and a long value is held to half the table`, async ({
    page,
  }) => {
    await open(page, width);
    const layout = await page.evaluate(() => {
      // Whether a cell's text is cut, ends in an ellipsis inside its cell, and takes focus to open
      // the tooltip with the whole value.
      const cut = (cell: Element) => {
        const text = cell.querySelector(':scope > .cinder-table__cell-text') as HTMLElement | null;
        if (!text) return undefined;
        return {
          style: getComputedStyle(text).textOverflow,
          cut: text.scrollWidth > text.clientWidth,
          fits: text.getBoundingClientRect().right <= cell.getBoundingClientRect().right + 0.5,
          focusable: text.tabIndex === 0,
        };
      };
      const boxes = ['fit-columns', 'fit-columns-long'].map((id) => {
        const scroll = document.querySelector(`[data-testid="${id}"] .cinder-table-scroll`)!;
        return { client: scroll.clientWidth, scroll: scroll.scrollWidth };
      });
      const longTable = document.querySelector('[data-testid="fit-columns-long"] table')!;
      const [name, key] = Array.from(longTable.querySelectorAll('tbody td'));
      return {
        boxes,
        table: longTable.getBoundingClientRect().width,
        nameWidth: name!.getBoundingClientRect().width,
        name: cut(name!),
        key: cut(key!),
      };
    });
    for (const box of layout.boxes) expect(box.scroll).toBeLessThanOrEqual(box.client);
    expect(layout.nameWidth).toBeLessThanOrEqual(layout.table / 2 + 1);
    const ended = { style: 'ellipsis', cut: true, fits: true, focusable: true };
    expect(layout.name).toEqual(ended);
    expect(layout.key).toEqual(ended);
  });

  test(`at ${width}px prose in the fill column keeps a readable measure`, async ({ page }) => {
    await open(page, width);
    const measures = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll('[data-testid="fit-columns"] .cinder-table__cell-prose'),
        (prose) => ({
          width: prose.getBoundingClientRect().width,
          cap: Number.parseFloat(getComputedStyle(prose).maxInlineSize),
        }),
      ),
    );
    expect(measures).toHaveLength(3);
    for (const prose of measures) {
      expect(Number.isFinite(prose.cap)).toBe(true);
      expect(prose.width).toBeLessThanOrEqual(prose.cap + 0.5);
    }
  });
}

test('at 375px the sized fit table still stacks into flat rows', async ({ page }) => {
  await open(page, 375);
  await expect(
    page.getByTestId('fit-columns').locator('table[data-cinder-stack-card]'),
  ).toBeVisible();
  const scroll = await page
    .getByTestId('fit-columns')
    .locator('.cinder-table-scroll')
    .evaluate((node) => ({ client: node.clientWidth, scroll: node.scrollWidth }));
  expect(scroll.scroll).toBeLessThanOrEqual(scroll.client);
});
