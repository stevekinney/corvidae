import { describe, expect, test } from 'bun:test';

import { parse, type Rule } from 'postcss';

// Table, DataTable and DataGrid share one fill rule: a table takes the same fill as a card on the
// same page, the header row is no darker band, and a hovered row is a faint tint of that fill.
// The tables once filled themselves with `--cinder-surface`, a lavender grey a step below the
// white card in light and a step below the card in dark, with a darker header band and hover.

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

async function declarations(path: string) {
  const root = parse(await read(path));
  const found: Array<{ selector: string; property: string; value: string }> = [];
  root.walkRules((rule: Rule) => {
    rule.walkDecls((declaration) => {
      found.push({ selector: rule.selector, property: declaration.prop, value: declaration.value });
    });
  });
  return found;
}

function valueOf(
  found: Awaited<ReturnType<typeof declarations>>,
  selector: string,
  property: string,
) {
  const match = found.filter((entry) => entry.selector === selector && entry.property === property);
  expect(match).toHaveLength(1);
  return match[0]!.value.replace(/\s+/g, ' ');
}

const files = {
  table: '../table/table.css',
  dataTable: '../data-table/data-table.css',
  dataGrid: '../data-grid/data-grid.css',
} as const;

describe('table fill', () => {
  test('a table and a grid take the same fill as a card', async () => {
    const card = await declarations('../card/card.css');
    const cardFill = valueOf(card, '.cinder-card', 'background');

    const table = await declarations(files.table);
    expect(valueOf(table, '.cinder-table', '--_cinder-table-fill')).toBe(cardFill);
    expect(valueOf(table, '.cinder-table', 'background')).toBe('var(--_cinder-table-fill)');
    expect(valueOf(table, '.cinder-table-scroll', 'background')).toBe(cardFill);
    expect(valueOf(table, '.cinder-table-scroll', '--_cinder-scroll-fade-color')).toBe(cardFill);

    const grid = await declarations(files.dataGrid);
    expect(valueOf(grid, '.cinder-data-grid', '--_cinder-data-grid-fill')).toBe(cardFill);
    expect(valueOf(grid, '.cinder-data-grid', 'background')).toBe('var(--_cinder-data-grid-fill)');
    expect(valueOf(grid, '.cinder-data-grid__row', 'background')).toBe(
      'var(--_cinder-data-grid-fill)',
    );
  });

  test('the header row is no darker band', async () => {
    const table = await declarations(files.table);
    expect(valueOf(table, '.cinder-table__header', 'background')).toBe('var(--_cinder-table-fill)');

    const grid = await declarations(files.dataGrid);
    expect(valueOf(grid, '.cinder-data-grid__header-row', 'background')).toBe(
      'var(--_cinder-data-grid-fill)',
    );

    const dataTable = await declarations(files.dataTable);
    expect(valueOf(dataTable, '.cinder-data-table__group-cell', 'background')).toBe(
      'var(--_cinder-table-fill)',
    );
  });

  test('a hovered row is a faint accent tint of the fill', async () => {
    const table = await declarations(files.table);
    expect(valueOf(table, '.cinder-table', '--_cinder-table-row-hover')).toBe(
      'color-mix( in oklch, var(--_cinder-table-fill), var(--cinder-accent-solid) 4% )',
    );
    expect(valueOf(table, '.cinder-table__body .cinder-table__row:hover', 'background')).toBe(
      'var(--_cinder-table-row-hover)',
    );

    const grid = await declarations(files.dataGrid);
    expect(valueOf(grid, '.cinder-data-grid', '--_cinder-data-grid-row-hover')).toBe(
      'color-mix( in oklch, var(--_cinder-data-grid-fill), var(--cinder-accent-solid) 4% )',
    );
    expect(valueOf(grid, '.cinder-data-grid__row:hover', 'background')).toBe(
      'var(--_cinder-data-grid-row-hover)',
    );
  });

  test('a frameless table fills its opaque parts with the page canvas', async () => {
    const table = await declarations(files.table);
    expect(
      valueOf(
        table,
        '.cinder-table[data-cinder-frameless],\n  .cinder-table-scroll[data-cinder-frameless]',
        '--_cinder-table-fill',
      ),
    ).toBe('var(--cinder-surface-canvas)');
  });

  test('no table paints the grey surface, the inset well or the surface hover', async () => {
    for (const path of Object.values(files)) {
      const painted = (await declarations(path)).filter(
        (entry) => entry.property === 'background' || entry.property.startsWith('--_'),
      );
      for (const entry of painted) {
        expect(entry.value).not.toMatch(/var\(--cinder-surface(-inset|-hover)?\)/);
      }
    }
  });
});
