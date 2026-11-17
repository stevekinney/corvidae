import { describe, expect, test } from 'bun:test';

import { parse, type Rule } from 'postcss';

// Table, DataTable and DataGrid share one fill rule: a table takes the same fill as a card body on
// the same page, the header row is no darker band, and a hovered row is a faint tint of that fill.
// The tables once painted a darker inset band under the DataGrid header and the DataTable group
// rows, and hovered a row with the surface hover, a full step below the fill.

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

type Declaration = { selector: string; property: string; value: string };

async function declarations(path: string): Promise<Declaration[]> {
  const root = parse(await read(path));
  const found: Declaration[] = [];
  root.walkRules((rule: Rule) => {
    rule.walkDecls((declaration) => {
      found.push({
        selector: rule.selector.replace(/\s+/g, ' '),
        property: declaration.prop,
        value: declaration.value.replace(/\s+/g, ' '),
      });
    });
  });
  return found;
}

function valueOf(found: Declaration[], selector: string, property: string) {
  const match = found.filter((entry) => entry.selector === selector && entry.property === property);
  expect(match).toHaveLength(1);
  return match[0]!.value;
}

const files = {
  table: '../table/table.css',
  dataTable: '../../../../cinder/src/components/data-table/data-table.css',
  dataGrid: '../../../../data-grid/src/components/data-grid/data-grid.css',
} as const;

describe('table fill', () => {
  test('a table and a grid take the same fill as a card body', async () => {
    const card = await declarations('../../../../card/src/components/card/card.css');
    const cardFill = valueOf(card, '.cinder-card__body', 'background');

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

  test('the header row and the group rows are no darker band', async () => {
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
      'color-mix( in oklch, var(--_cinder-table-fill), var(--cinder-accent-solid) 3% )',
    );
    expect(valueOf(table, '.cinder-table__body .cinder-table__row:hover', 'background')).toBe(
      'var(--_cinder-table-row-hover)',
    );

    const dataTable = await declarations(files.dataTable);
    expect(
      valueOf(dataTable, '.cinder-data-table tbody .cinder-table__row:focus-within', 'background'),
    ).toBe('var(--_cinder-table-row-hover)');

    const grid = await declarations(files.dataGrid);
    expect(valueOf(grid, '.cinder-data-grid', '--_cinder-data-grid-row-hover')).toBe(
      'color-mix( in oklch, var(--_cinder-data-grid-fill), var(--cinder-accent-solid) 3% )',
    );
    expect(valueOf(grid, '.cinder-data-grid__row:hover', 'background')).toBe(
      'var(--_cinder-data-grid-row-hover)',
    );
  });

  test('a frameless table paints nothing behind its header unless the header is pinned', async () => {
    const table = await declarations(files.table);
    expect(
      valueOf(
        table,
        '.cinder-table[data-cinder-frameless], .cinder-table-scroll[data-cinder-frameless]',
        '--_cinder-table-fill',
      ),
    ).toBe('transparent');
    expect(
      valueOf(
        table,
        '.cinder-table[data-cinder-frameless][data-cinder-sticky-header] .cinder-table__header',
        'background',
      ),
    ).toBe('var(--cinder-surface-canvas)');
  });

  test('no table paints the inset well or the surface hover', async () => {
    for (const path of Object.values(files)) {
      for (const entry of await declarations(path)) {
        expect(entry.value).not.toMatch(/var\(--cinder-surface-(inset|hover)\)/);
      }
    }
  });
});
