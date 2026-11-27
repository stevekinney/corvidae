/// <reference lib="dom" />
/**
 * COR-2771: Table chooses its stacked form in CSS, by a size container query, and its server HTML
 * carries the column labels and card marks, so a page with no script already paints the right form
 * and hydration moves nothing.
 *
 * `src/fixtures/table-first-paint.svelte` reads no browser global, so the same file is rendered on
 * the server (served with JavaScript off by `scripts/server-rendered-page.ts`) and mounted by the
 * fixture host, whose page has hydrated before it is measured.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  openServerRenderedPage,
  renderServerPage,
  type ServerRenderedPage,
} from '../scripts/server-rendered-page.ts';

const SOURCE = new URL('../src/fixtures/table-first-paint.svelte', import.meta.url).pathname;
const PATH = '/server-rendered/table-first-paint';
const TABLES = ['namespaces', 'loading', 'controls', 'sortable', 'data-table'] as const;

let rendered: ServerRenderedPage;

test.beforeAll(async () => {
  const page = await renderServerPage(SOURCE);
  // The server render returns the body only, so the fixture's layout stylesheet, which the client
  // imports, joins the served page's head here.
  const layout = await Bun.file(
    new URL('../src/fixtures/table-first-paint.css', import.meta.url),
  ).text();
  rendered = {
    ...page,
    document: (theme) =>
      page.document(theme).replace('</head>', () => `<style>${layout}</style></head>`),
  };
});

test.use({ javaScriptEnabled: false });

type CellBox = { x: number; y: number; width: number; height: number; label: string };

/** Each body cell of the table in `section`: its box relative to the section, and its `::before`. */
async function cellBoxes(page: Page, section: string): Promise<CellBox[]> {
  return page.evaluate((id) => {
    const root = document.querySelector(`[data-testid="${id}"]`);
    if (!root) throw new Error(`no section ${id}`);
    const origin = root.getBoundingClientRect();
    return Array.from(root.querySelectorAll('tbody td, tbody th'), (cell) => {
      const box = cell.getBoundingClientRect();
      return {
        x: box.x - origin.x,
        y: box.y - origin.y,
        width: box.width,
        height: box.height,
        label: getComputedStyle(cell, '::before').content,
      };
    });
  }, section);
}

async function openServerPage(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await openServerRenderedPage(page, rendered, { path: PATH });
  await expect(page.locator('[data-testid="namespaces"] table')).toBeVisible();
}

async function openHydratedPage(browser: Browser, width: number) {
  const context = await browser.newContext({
    javaScriptEnabled: true,
    viewport: { width, height: 900 },
    hasTouch: width < 768,
  });
  const page = await context.newPage();
  await page.goto(fixtureRoute('table-first-paint'), { waitUntil: 'load' });
  await expect(page.locator('[data-testid="namespaces"] table')).toBeVisible();
  // The table's script has run: it watches its container once mounted.
  await page.waitForFunction(
    () => document.querySelectorAll('.cinder-table-container').length >= 7,
  );
  return { context, page };
}

for (const width of [375, 1280]) {
  test(`at ${width}px hydration changes no cell's box or label`, async ({ page, browser }) => {
    await openServerPage(page, width);
    const { context, page: hydrated } = await openHydratedPage(browser, width);
    try {
      for (const section of [...TABLES, 'narrow-column', 'wide-column']) {
        const first = await cellBoxes(page, section);
        const after = await cellBoxes(hydrated, section);
        expect(after.length).toBe(first.length);
        for (const [index, cell] of first.entries()) {
          const other = after[index]!;
          expect(other.label, `${section} cell ${index} label`).toBe(cell.label);
          for (const side of ['x', 'y', 'width', 'height'] as const) {
            expect(
              Math.abs(other[side] - cell[side]),
              `${section} cell ${index} ${side}`,
            ).toBeLessThanOrEqual(1);
          }
        }
      }
    } finally {
      await context.close();
    }
  });
}

test.describe('with no script, on a phone', () => {
  test.use({ hasTouch: true });

  test('every table is stacked, labelled, and fits its card', async ({ page }) => {
    await openServerPage(page, 375);
    for (const section of TABLES) {
      const layout = await page.evaluate((id) => {
        const root = document.querySelector(`[data-testid="${id}"]`)!;
        const table = root.querySelector('table')!;
        const box = root.querySelector('.cinder-table-scroll')!;
        const header = table.querySelector('thead')!;
        const labels = Array.from(table.querySelectorAll('thead th'), (cell) =>
          cell.getAttribute('data-cinder-label'),
        );
        const cells = Array.from(table.querySelectorAll('tbody tr'), (row) =>
          Array.from(row.children).map((cell, index) => {
            const before = getComputedStyle(cell, '::before');
            const cellBox = cell.getBoundingClientRect();
            const style = getComputedStyle(cell);
            const labelStart = cellBox.left + Number.parseFloat(style.paddingLeft);
            const labelEnd = labelStart + (Number.parseFloat(before.width) || 0);
            const range = document.createRange();
            range.selectNodeContents(cell);
            const valueStart = Math.min(
              ...Array.from(range.getClientRects(), (rect) => rect.left).filter(Number.isFinite),
            );
            return {
              column: labels[index],
              label: before.content,
              shown: style.display !== 'none',
              // The title, a placed part (`stack`: status, end, plain) and a control's cell print
              // no label before the value.
              unlabelled:
                cell.hasAttribute('data-cinder-stack-title') ||
                cell.hasAttribute('data-cinder-stack') ||
                cell.hasAttribute('data-cinder-controls'),
              labelBox: {
                start: labelStart,
                end: labelEnd,
                top: cellBox.top,
                bottom: cellBox.bottom,
              },
              // A control's label follows the control (`order: 1`), so only a leading label can
              // cover the value.
              overlaps:
                !cell.hasAttribute('data-cinder-controls') &&
                before.content !== 'none' &&
                valueStart < labelEnd - 0.5,
            };
          }),
        );
        return {
          scroll: box.scrollWidth,
          client: box.clientWidth,
          headerHidden: getComputedStyle(header).clipPath === 'inset(50%)',
          cells,
        };
      }, section);
      expect(layout.scroll, `${section} fits its card`).toBeLessThanOrEqual(layout.client);
      expect(layout.headerHidden, `${section} hides its header row`).toBe(true);
      for (const row of layout.cells) {
        for (const cell of row) {
          if (!cell.shown) continue;
          // A labelled field prints its column's label from the server's HTML.
          if (section !== 'controls' && !cell.unlabelled) {
            expect(cell.label, `${section} ${cell.column}`).toBe(`"${cell.column}"`);
          }
          expect(cell.overlaps, `${section} ${cell.column} label and value`).toBe(false);
        }
        // No two labels in a row sit on each other: the "Namespace over State" defect.
        const boxes = row
          .filter((cell) => cell.shown && cell.label !== 'none')
          .map((cell) => cell.labelBox);
        for (const [index, box] of boxes.entries()) {
          for (const other of boxes.slice(index + 1)) {
            const intersects =
              box.start < other.end &&
              other.start < box.end &&
              box.top < other.bottom &&
              other.top < box.bottom;
            expect(intersects, `${section} labels overlap`).toBe(false);
          }
        }
      }
    }
  });
});

test('with no script, at 1280px every table is wide', async ({ page }) => {
  await openServerPage(page, 1280);
  for (const section of TABLES) {
    const layout = await page.evaluate((id) => {
      const root = document.querySelector(`[data-testid="${id}"]`)!;
      const table = root.querySelector('table')!;
      const box = root.querySelector('.cinder-table-scroll')!;
      const header = table.querySelector('thead')!;
      const style = getComputedStyle(box);
      const content =
        box.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      return {
        headerHeight: header.getBoundingClientRect().height,
        headerClip: getComputedStyle(header).clipPath,
        labels: Array.from(
          table.querySelectorAll('tbody td, tbody th'),
          (cell) => getComputedStyle(cell, '::before').content,
        ),
        table: table.getBoundingClientRect().width,
        content,
      };
    }, section);
    expect(layout.headerHeight, `${section} header`).toBeGreaterThan(1);
    expect(layout.headerClip).toBe('none');
    expect(layout.labels.every((label) => label === 'none' || label === 'normal')).toBe(true);
    expect(Math.abs(layout.table - layout.content), `${section} width`).toBeLessThanOrEqual(1);
  }
});

/** Whether each sortable section's stacked sort control is drawn, by section. */
async function sortControlShown(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() =>
    Object.fromEntries(
      ['sortable', 'data-table'].map((id) => {
        const row = document.querySelector(`[data-testid="${id}"] .cinder-table__stack-sort`);
        return [id, row !== null && row.getBoundingClientRect().height > 0];
      }),
    ),
  );
}

test('with no script, a sortable table holds its sort control on a phone and not when wide', async ({
  page,
}) => {
  await openServerPage(page, 375);
  expect(await sortControlShown(page)).toEqual({ sortable: true, 'data-table': true });
  await openServerPage(page, 1280);
  expect(await sortControlShown(page)).toEqual({ sortable: false, 'data-table': false });
});

type SortControlState = { control: DOMRectReadOnly; firstRowTop: number; disabled: boolean };

/** Each sortable section's sort control box, its first row's top, and whether its select is disabled. */
async function sortControlState(page: Page): Promise<Record<string, SortControlState>> {
  return page.evaluate(() =>
    Object.fromEntries(
      ['sortable', 'data-table'].map((id) => {
        const root = document.querySelector(`[data-testid="${id}"]`)!;
        const origin = root.getBoundingClientRect();
        const control = root.querySelector('.cinder-table__stack-sort')!.getBoundingClientRect();
        const row = root.querySelector('tbody tr')!.getBoundingClientRect();
        const select = root.querySelector<HTMLSelectElement>('.cinder-table__stack-sort select')!;
        return [
          id,
          {
            control: new DOMRectReadOnly(
              control.x - origin.x,
              control.y - origin.y,
              control.width,
              control.height,
            ).toJSON(),
            firstRowTop: row.top - origin.y,
            disabled: select.disabled,
          },
        ];
      }),
    ),
  );
}

test('at 375px hydration fills the sort control without moving it or the rows', async ({
  page,
  browser,
}) => {
  await openServerPage(page, 375);
  const { context, page: hydrated } = await openHydratedPage(browser, 375);
  try {
    const first = await sortControlState(page);
    await expect
      .poll(async () => Object.values(await sortControlState(hydrated)).map((s) => s.disabled))
      .toEqual([false, false]);
    const after = await sortControlState(hydrated);
    for (const id of ['sortable', 'data-table']) {
      // Before hydration the select has no options, so it is disabled: no one lands on an empty
      // listbox. Its visible label holds its place.
      expect(first[id]!.disabled, `${id} disabled before hydration`).toBe(true);
      for (const side of ['x', 'y', 'width', 'height'] as const) {
        expect(
          Math.abs(after[id]!.control[side] - first[id]!.control[side]),
          `${id} sort control ${side}`,
        ).toBeLessThanOrEqual(0.5);
      }
      expect(
        Math.abs(after[id]!.firstRowTop - first[id]!.firstRowTop),
        `${id} first row top`,
      ).toBeLessThanOrEqual(0.5);
    }
  } finally {
    await context.close();
  }
});

test('with no script, the container decides, not the window', async ({ page }) => {
  await openServerPage(page, 1280);
  const headerHidden = (section: string) =>
    page.evaluate(
      (id) =>
        getComputedStyle(document.querySelector(`[data-testid="${id}"] thead`)!).clipPath ===
        'inset(50%)',
      section,
    );
  // The same `fit` table: stacked in a 320px column, wide in an 880px one, in a 1280px window.
  expect(await headerHidden('narrow-column')).toBe(true);
  expect(await headerHidden('wide-column')).toBe(false);
});
