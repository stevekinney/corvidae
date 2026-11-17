/// <reference lib="dom" />
/**
 * A selected, hovered or focused row in ListDetail has one shape wherever it sits: first under a
 * group heading, in the middle, or last in a group. The row is inset from both pane edges and from
 * the heading above it, rounds all four corners with the radius Cinder's other selectable lists
 * use (side navigation and menu rows, `--cinder-radius-sm`), and keeps its title on the header's
 * text edge. Read in a browser on the `grouped-selection` fixture, the documented tools example.
 */

import { expect, test, type Page } from '@playwright/test';
import { fixtureRoute } from '@lostgradient/testing/browser/overlay-fixture';

const RADIUS = '6px';
const INSET = 8;
const GAP_BETWEEN_ROWS = 4;

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 375, height: 900 },
] as const;

type RowShape = {
  key: string;
  radii: string[];
  insetStart: number;
  insetEnd: number;
  gapAbove: number;
  gapBelow: number | null;
  textEdge: number;
};

/** Every row's corners and its distances to the pane edges and to what sits above and below it. */
async function rowShapes(page: Page): Promise<{ headerTextEdge: number; rows: RowShape[] }> {
  return page.locator('.cinder-list-detail').evaluate((root) => {
    const round = (value: number): number => Math.round(value * 100) / 100;
    const pane = root.querySelector('.cinder-list-detail__rows');
    const header = root.querySelector('.cinder-list-detail__header');
    if (pane === null || header === null) throw new Error('Missing list pane or header');
    const paneRectangle = pane.getBoundingClientRect();
    const rowOf = (item: Element | null): Element | null =>
      item?.querySelector('.cinder-selectable-row') ?? null;
    const groupHeaderOf = (group: Element | null): Element | null =>
      group?.querySelector(':scope > .cinder-data-list-group__header') ?? null;
    const rows = [...root.querySelectorAll('[data-cinder-list-detail-key]')].map((item) => {
      const row = rowOf(item);
      const title = item.querySelector('.cinder-selectable-row__title');
      if (row === null || title === null) throw new Error('Missing selectable row');
      const rectangle = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      const group = item.closest('.cinder-data-list-group');
      const above =
        rowOf(item.previousElementSibling) ?? groupHeaderOf(group) ?? pane.firstElementChild;
      const below =
        rowOf(item.nextElementSibling) ?? groupHeaderOf(group?.nextElementSibling ?? null);
      if (above === null) throw new Error('Nothing above the row');
      return {
        key: item.getAttribute('data-cinder-list-detail-key') ?? '',
        radii: [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ],
        insetStart: round(rectangle.left - paneRectangle.left),
        insetEnd: round(paneRectangle.right - rectangle.right),
        gapAbove: round(rectangle.top - above.getBoundingClientRect().bottom),
        gapBelow:
          below === null ? null : round(below.getBoundingClientRect().top - rectangle.bottom),
        textEdge: round(title.getBoundingClientRect().left - paneRectangle.left),
      };
    });
    const headerTextEdge = round(
      header.getBoundingClientRect().left -
        paneRectangle.left +
        Number.parseFloat(getComputedStyle(header).paddingLeft),
    );
    return { headerTextEdge, rows };
  });
}

/** The painted box of one row: its corners, its fill and its ring. */
async function paint(page: Page, key: string) {
  return page.locator(`[data-cinder-list-detail-key="${key}"]`).evaluate((item) => {
    const row = item.querySelector('.cinder-selectable-row');
    const primary = item.querySelector('.cinder-selectable-row__primary');
    if (row === null || primary === null) throw new Error('Missing selectable row');
    const style = getComputedStyle(row);
    return {
      radii: [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ],
      background: style.backgroundColor,
      rowRing: style.boxShadow,
      primaryRing: getComputedStyle(primary).boxShadow,
    };
  });
}

for (const viewport of VIEWPORTS) {
  test.describe(`ListDetail row shape, ${viewport.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(fixtureRoute('list-detail', { fixtureName: 'grouped-selection' }), {
        waitUntil: 'load',
      });
      await page.locator('[data-cinder-list-detail-key] .cinder-selectable-row').first().waitFor();
    });

    test('every row is inset alike, rounds all four corners, and keeps the header text edge', async ({
      page,
    }) => {
      const { headerTextEdge, rows } = await rowShapes(page);
      const firstInGroup = new Set(['discover-agents', 'list-issues']);
      const lastInGroup = new Set(['schedule-wakeup']);
      const expected = rows.map((row) => ({
        key: row.key,
        radii: [RADIUS, RADIUS, RADIUS, RADIUS],
        insetStart: INSET,
        insetEnd: INSET,
        gapAbove: firstInGroup.has(row.key) ? INSET : GAP_BETWEEN_ROWS,
        gapBelow: lastInGroup.has(row.key)
          ? INSET
          : row.key === 'read-page'
            ? null
            : GAP_BETWEEN_ROWS,
        textEdge: headerTextEdge,
      }));
      expect(rows.map((row) => row.key)).toEqual([
        'discover-agents',
        'schedule-wakeup',
        'list-issues',
        'create-issue',
        'read-page',
      ]);
      expect(rows).toEqual(expected);
    });

    test('selected, hovered and focused rows share one shape, and focus rings the whole row', async ({
      page,
    }) => {
      const transparent = 'rgba(0, 0, 0, 0)';
      const selected = await paint(page, 'discover-agents');
      expect(selected.radii).toEqual([RADIUS, RADIUS, RADIUS, RADIUS]);
      expect(selected.background).not.toBe(transparent);

      await page
        .locator('[data-cinder-list-detail-key="list-issues"] .cinder-selectable-row')
        .hover();
      const hovered = await paint(page, 'list-issues');
      expect(hovered.radii).toEqual(selected.radii);
      expect(hovered.background).not.toBe(transparent);

      await page.mouse.move(0, 0);
      await page.keyboard.press('Tab');
      await page
        .locator('[data-cinder-list-detail-key="create-issue"] .cinder-selectable-row__primary')
        .focus();
      const focused = await paint(page, 'create-issue');
      expect(focused.radii).toEqual(selected.radii);
      expect(focused.rowRing).not.toBe('none');
      expect(focused.primaryRing).toBe('none');
    });
  });
}
