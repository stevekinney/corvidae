/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { requiredInstance, setupHappyDom, trackTimers } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import type { DataTableSelectionMode as RootDataTableSelectionMode } from '../../index.ts';
import type { DataTableRow } from './data-table.types.ts';
import type { DataTableSelectionMode } from './index.ts';

setupHappyDom();

const { cleanup, render, fireEvent, waitFor } = await import('@testing-library/svelte');
const { tick } = await import('svelte');
const { default: DataTable } = await import('./data-table.svelte');
const { default: SnippetsFixture } = await import('./data-table-snippets.fixture.svelte');

afterEach(() => cleanup());

const columns = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'role', label: 'Role' },
  { key: 'commits', label: 'Commits', sortable: true, align: 'end' as const },
];

const rows = [
  { name: 'Ada Lovelace', role: 'Mathematician', commits: 142 },
  { name: 'Grace Hopper', role: 'Computer Scientist', commits: 98 },
];

const rowsWithIds = [
  { id: 'ada', name: 'Ada Lovelace', role: 'Mathematician', commits: 142 },
  { id: 'grace', name: 'Grace Hopper', role: 'Computer Scientist', commits: 98 },
  { id: 'alan', name: 'Alan Turing', role: 'Cryptanalyst', commits: 76 },
];

function makeRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `Person ${index}`,
    role: `Role ${index % 5}`,
    commits: index,
  }));
}

function bodyDataRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('tbody tr:not([aria-hidden="true"])'));
}

function rectWithHeight(height: number): DOMRect {
  return {
    bottom: height,
    height,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

describe('DataTable — table structure', () => {
  test('renders a semantic <table> element', () => {
    const { container } = render(DataTable, { columns, rows });
    expect(container.querySelector('table')).not.toBeNull();
  });

  test('renders <thead> and <tbody>', () => {
    const { container } = render(DataTable, { columns, rows });
    expect(container.querySelector('thead')).not.toBeNull();
    expect(container.querySelector('tbody')).not.toBeNull();
  });

  test('renders a <caption> when caption prop is supplied', () => {
    const { container } = render(DataTable, { columns, rows, caption: 'Contributor roster' });
    const caption = container.querySelector('caption');
    expect(caption).not.toBeNull();
    expect(caption?.textContent?.trim()).toBe('Contributor roster');
  });

  test('renders no <caption> when caption prop is omitted', () => {
    const { container } = render(DataTable, { columns, rows });
    expect(container.querySelector('caption')).toBeNull();
  });

  test('renders one <tr> in the header per column set', () => {
    const { container } = render(DataTable, { columns, rows });
    expect(container.querySelectorAll('thead tr').length).toBe(1);
  });

  test('renders one <tr> in the body per row', () => {
    const { container } = render(DataTable, { columns, rows });
    expect(container.querySelectorAll('tbody tr').length).toBe(rows.length);
  });

  test('omits header actions when columns are not resizable', () => {
    const { container } = render(DataTable, { columns, rows, resizable: false });

    expect(container.querySelector('.cinder-table__header-actions')).toBeNull();
    expect(container.querySelector('[role="separator"]')).toBeNull();
  });
});

describe('DataTable — column resizing', () => {
  test('retains cleanup for active document resize listeners', () => {
    const source = readFileSync(new URL('./data-table.svelte', import.meta.url), 'utf8');
    expect(source).toContain('let activeResizeCleanup');
    expect(source).toContain('onDestroy(() => activeResizeCleanup?.())');
  });
  test('renders keyboard-accessible separators and clamps arrow-key resizing', async () => {
    const resized: Array<[string, number]> = [];
    const { getByRole } = render(DataTable, {
      columns: [{ key: 'name', label: 'Name', width: 100, minWidth: 90, maxWidth: 110 }],
      rows,
      resizable: true,
      onColumnResize: (key: string, width: number) => resized.push([key, width]),
    });
    const separator = getByRole('separator', { name: 'Resize Name column' });

    expect(separator.getAttribute('aria-valuenow')).toBe('100');
    await fireEvent.keyDown(separator, { key: 'ArrowRight' });
    await fireEvent.keyDown(separator, { key: 'ArrowRight' });

    expect(separator.getAttribute('aria-valuenow')).toBe('110');
    expect(resized).toEqual([['name', 110]]);
  });

  test('resizes from pointer movement and reports the resulting width', async () => {
    const resized: Array<[string, number]> = [];
    const { getByRole } = render(DataTable, {
      columns: [{ key: 'name', label: 'Name', width: 120 }],
      rows,
      resizable: true,
      onColumnResize: (key: string, width: number) => resized.push([key, width]),
    });
    const separator = getByRole('separator', { name: 'Resize Name column' });
    Object.defineProperty(separator, 'setPointerCapture', { value: () => {} });

    await fireEvent.pointerDown(separator, { button: 0, clientX: 100, pointerId: 7 });
    await fireEvent.pointerMove(document, { clientX: 135, pointerId: 7 });
    await fireEvent.pointerUp(document, { clientX: 135, pointerId: 7 });

    expect(separator.getAttribute('aria-valuenow')).toBe('155');
    expect(resized.at(-1)).toEqual(['name', 155]);
  });

  test('reverses pointer resizing direction in RTL', async () => {
    const resized: number[] = [];
    const { container, getByRole } = render(DataTable, {
      columns: [{ key: 'name', label: 'Name', width: 120 }],
      rows,
      resizable: true,
      onColumnResize: (_key: string, width: number) => resized.push(width),
    });
    container.style.direction = 'rtl';
    const separator = getByRole('separator', { name: 'Resize Name column' });
    Object.defineProperty(separator, 'setPointerCapture', { value: () => {} });

    await fireEvent.pointerDown(separator, { button: 0, clientX: 100, pointerId: 8 });
    await fireEvent.pointerMove(document, { clientX: 135, pointerId: 8 });
    await fireEvent.pointerUp(document, { clientX: 135, pointerId: 8 });

    expect(resized.at(-1)).toBe(85);
    expect(separator.getAttribute('aria-valuenow')).toBe('85');
  });

  test('handles prototype-named column keys without width collisions', async () => {
    const { getByRole } = render(DataTable, {
      columns: [{ key: 'constructor', label: 'Constructor', width: 100 }],
      rows,
      resizable: true,
    });
    const separator = getByRole('separator', { name: 'Resize Constructor column' });
    expect(separator.getAttribute('aria-valuenow')).toBe('100');
    await fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator.getAttribute('aria-valuenow')).toBe('110');
  });

  test('clamps the initial separator value when width is omitted', () => {
    const { getByRole } = render(DataTable, {
      columns: [{ key: 'name', label: 'Name', minWidth: 80, maxWidth: 120 }],
      rows,
      resizable: true,
    });
    expect(
      getByRole('separator', { name: 'Resize Name column' }).getAttribute('aria-valuenow'),
    ).toBe('120');
  });

  test('renders the default width represented by an omitted column width', () => {
    const { container, getByRole } = render(DataTable, {
      columns: [{ key: 'name', label: 'Name' }],
      rows,
      resizable: true,
    });
    expect(container.querySelector('thead th')?.getAttribute('style')).toContain('width: 150px');
    expect(
      getByRole('separator', { name: 'Resize Name column' }).getAttribute('aria-valuenow'),
    ).toBe('150');
  });

  test('provides a finite aria-valuemax when maxWidth is omitted', () => {
    const { getByRole } = render(DataTable, {
      columns: [{ key: 'name', label: 'Name', width: 100 }],
      rows,
      resizable: true,
    });
    expect(
      getByRole('separator', { name: 'Resize Name column' }).getAttribute('aria-valuemax'),
    ).toBe(String(Number.MAX_SAFE_INTEGER));
  });

  test('normalizes non-finite width bounds and values', () => {
    const { container, getByRole } = render(DataTable, {
      columns: [
        {
          key: 'name',
          label: 'Name',
          width: Number.NaN,
          minWidth: Number.NaN,
          maxWidth: Number.POSITIVE_INFINITY,
        },
      ],
      rows,
      resizable: true,
    });
    const separator = getByRole('separator', { name: 'Resize Name column' });
    expect(separator.getAttribute('aria-valuenow')).toBe('150');
    expect(separator.getAttribute('aria-valuemin')).toBe('60');
    expect(separator.getAttribute('aria-valuemax')).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(container.querySelector('thead th')?.getAttribute('style')).toContain('width: 150px');
  });

  test('normalizes contradictory finite width bounds for sizing and ARIA', () => {
    const { getByRole } = render(DataTable, {
      columns: [{ key: 'name', label: 'Name', width: 150, minWidth: 200, maxWidth: 100 }],
      rows,
      resizable: true,
    });
    const separator = getByRole('separator', { name: 'Resize Name column' });
    expect(separator.getAttribute('aria-valuemin')).toBe('100');
    expect(separator.getAttribute('aria-valuemax')).toBe('200');
    expect(separator.getAttribute('aria-valuenow')).toBe('150');
  });

  test('clamps the initial rendered column width to its bounds', () => {
    const { container, getByRole } = render(DataTable, {
      columns: [{ key: 'name', label: 'Name', width: 40, minWidth: 80, maxWidth: 120 }],
      rows,
      resizable: true,
    });
    const header = container.querySelector('thead th');
    expect(header?.getAttribute('style')).toContain('width: 80px');
    expect(
      getByRole('separator', { name: 'Resize Name column' }).getAttribute('aria-valuenow'),
    ).toBe('80');
  });

  test('treats external column width changes as authoritative after resizing', async () => {
    const view = render(DataTable, {
      columns: [{ key: 'name', label: 'Name', width: 100 }],
      rows,
      resizable: true,
    });
    const separator = view.getByRole('separator', { name: 'Resize Name column' });
    await fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator.getAttribute('aria-valuenow')).toBe('110');

    await view.rerender({
      columns: [{ key: 'name', label: 'Name', width: 180 }],
      rows,
      resizable: true,
    });
    await tick();

    expect(separator.getAttribute('aria-valuenow')).toBe('180');
    expect(view.container.querySelector('thead th')?.getAttribute('style')).toContain(
      'width: 180px',
    );
  });

  test('clears cached resize values when a column disappears', () => {
    const source = readFileSync(new URL('./data-table.svelte', import.meta.url), 'utf8');
    expect(source).toContain('const removedKeys = Array.from(previousExternalColumnWidths.keys())');
    expect(source).toContain('(key) => !externalColumnWidths.has(key)');
    expect(source).toContain('const resetKeys = [...changedKeys, ...removedKeys]');
    expect(source).toContain('for (const key of resetKeys) delete nextColumnWidths[key]');
  });

  test('uses fixed table layout so resize values describe rendered widths', () => {
    const css = readFileSync(new URL('./data-table.css', import.meta.url), 'utf8');
    const { container } = render(DataTable, {
      columns: [{ key: 'name', label: 'Name', width: 100 }],
      rows,
      resizable: true,
    });
    expect(
      container.querySelector('.cinder-data-table')?.hasAttribute('data-cinder-resizable'),
    ).toBe(true);
    expect(css).toContain('.cinder-data-table[data-cinder-resizable] .cinder-table');
    expect(css).toContain('table-layout: fixed;');
    expect(css).toContain('inline-size: var(--_cinder-data-table-width);');
    expect(css).toContain('min-inline-size: var(--_cinder-data-table-width);');
    expect(container.querySelector('.cinder-data-table')?.getAttribute('style')).toContain(
      '--_cinder-data-table-width: 100px',
    );
  });
});

describe('DataTable — column headers', () => {
  test('renders one <th scope="col"> per column in the header', () => {
    const { container } = render(DataTable, { columns, rows });
    const headerCells = Array.from(container.querySelectorAll('thead th'));
    expect(headerCells.length).toBe(columns.length);
    for (const cell of headerCells) {
      expect(cell.getAttribute('scope')).toBe('col');
    }
  });

  test('header cells contain the column labels', () => {
    const { container } = render(DataTable, { columns, rows });
    const headerCells = Array.from(container.querySelectorAll('thead th'));
    expect(headerCells[0]?.textContent?.trim()).toContain('Name');
    expect(headerCells[1]?.textContent?.trim()).toContain('Role');
    expect(headerCells[2]?.textContent?.trim()).toContain('Commits');
  });

  test('sortable header cells contain a sort button', () => {
    const { container } = render(DataTable, { columns, rows });
    const headerCells = Array.from(container.querySelectorAll('thead th'));
    // Name and Commits are sortable
    expect(headerCells[0]?.querySelector('button')).not.toBeNull();
    expect(headerCells[2]?.querySelector('button')).not.toBeNull();
    // Role is not sortable
    expect(headerCells[1]?.querySelector('button')).toBeNull();
  });

  test('sortable header cells default to aria-sort="none"', () => {
    const { container } = render(DataTable, { columns, rows });
    const headerCells = Array.from(container.querySelectorAll('thead th'));
    expect(headerCells[0]?.getAttribute('aria-sort')).toBe('none');
    expect(headerCells[2]?.getAttribute('aria-sort')).toBe('none');
  });

  test('non-sortable header cells have no aria-sort attribute', () => {
    const { container } = render(DataTable, { columns, rows });
    const headerCells = Array.from(container.querySelectorAll('thead th'));
    expect(headerCells[1]?.getAttribute('aria-sort')).toBeNull();
  });

  test('aria-sort reflects the bound sort state for the active column', () => {
    const { container } = render(DataTable, {
      columns,
      rows,
      sort: { column: 'name', direction: 'ascending' },
    });
    const headerCells = Array.from(container.querySelectorAll('thead th'));
    expect(headerCells[0]?.getAttribute('aria-sort')).toBe('ascending');
    expect(headerCells[2]?.getAttribute('aria-sort')).toBe('none');
  });

  test('sortable header buttons describe their next sort action', async () => {
    const { container } = render(DataTable, { columns, rows });
    const button = requiredInstance(container.querySelector('thead th button'), HTMLButtonElement);

    expect(button.getAttribute('aria-description')).toBe('Activate to sort ascending');

    await fireEvent.click(button);
    expect(button.getAttribute('aria-description')).toBe('Activate to sort descending');
  });
});

describe('DataTable — sort interaction', () => {
  test('clicking a sortable header updates aria-sort to ascending', async () => {
    const { container } = render(DataTable, { columns, rows });
    const button = requiredInstance(container.querySelector('thead th button'), HTMLButtonElement);
    await fireEvent.click(button);
    const headerCells = Array.from(container.querySelectorAll('thead th'));
    expect(headerCells[0]?.getAttribute('aria-sort')).toBe('ascending');
  });

  test('clicking an ascending column header toggles to descending', async () => {
    const { container } = render(DataTable, {
      columns,
      rows,
      sort: { column: 'name', direction: 'ascending' },
    });
    const button = requiredInstance(container.querySelector('thead th button'), HTMLButtonElement);
    await fireEvent.click(button);
    const headerCells = Array.from(container.querySelectorAll('thead th'));
    expect(headerCells[0]?.getAttribute('aria-sort')).toBe('descending');
  });

  test('never reorders rows itself — clicking a sort header leaves body order unchanged', async () => {
    // DataTable is controlled: it reports sort intent via the bindable `sort`
    // prop but the consumer owns row ordering. Clicking a sortable header must
    // NOT reorder the DOM rows — only the caller re-sorting `rows` does that.
    const { container } = render(DataTable, { columns, rows });
    const rowHeaderText = () =>
      Array.from(container.querySelectorAll('tbody tr th[scope="row"]')).map(
        (cell) => cell.textContent,
      );
    const before = rowHeaderText();
    expect(before).toEqual(['Ada Lovelace', 'Grace Hopper']);
    // 'commits' is sortable and would, if the component sorted internally,
    // reorder Grace (98) above Ada (142) on ascending.
    const commitsButton = requiredInstance(
      container.querySelectorAll('thead th button')[1],
      HTMLButtonElement,
    );
    await fireEvent.click(commitsButton);
    expect(rowHeaderText()).toEqual(before);
  });
});

describe('DataTable — row header cells (scope="row")', () => {
  test('first column body cells are <th scope="row"> by default', () => {
    const simpleColumns = [
      { key: 'name', label: 'Name' },
      { key: 'role', label: 'Role' },
    ];
    const simpleRows = [{ name: 'Ada Lovelace', role: 'Mathematician' }];
    const { container } = render(DataTable, { columns: simpleColumns, rows: simpleRows });
    const bodyRows = container.querySelectorAll('tbody tr');
    const firstCell = bodyRows[0]?.querySelector('th');
    expect(firstCell).not.toBeNull();
    expect(firstCell?.getAttribute('scope')).toBe('row');
  });

  test('non-rowHeader columns render as <td>', () => {
    const simpleColumns = [
      { key: 'name', label: 'Name' },
      { key: 'role', label: 'Role' },
    ];
    const simpleRows = [{ name: 'Ada Lovelace', role: 'Mathematician' }];
    const { container } = render(DataTable, { columns: simpleColumns, rows: simpleRows });
    const bodyRows = container.querySelectorAll('tbody tr');
    const cells = Array.from(bodyRows[0]?.querySelectorAll('td') ?? []);
    expect(cells.length).toBe(1); // only 'role' is <td>
    expect(cells[0]?.textContent?.trim()).toBe('Mathematician');
  });

  test('explicit rowHeader: true on a non-first column makes that column the row header', () => {
    const customColumns = [
      { key: 'id', label: 'ID' },
      { key: 'name', label: 'Name', rowHeader: true },
      { key: 'role', label: 'Role' },
    ];
    const customRows = [{ id: '1', name: 'Ada Lovelace', role: 'Mathematician' }];
    const { container } = render(DataTable, { columns: customColumns, rows: customRows });
    const bodyRows = container.querySelectorAll('tbody tr');
    const cells = Array.from(bodyRows[0]?.querySelectorAll('th, td') ?? []);
    // id → td, name → th scope=row, role → td
    expect(cells[0]?.tagName.toLowerCase()).toBe('td');
    expect(cells[1]?.tagName.toLowerCase()).toBe('th');
    expect(cells[1]?.getAttribute('scope')).toBe('row');
    expect(cells[2]?.tagName.toLowerCase()).toBe('td');
  });

  test('row header cell contains the correct value', () => {
    const { container } = render(DataTable, { columns, rows });
    const bodyRows = Array.from(container.querySelectorAll('tbody tr'));
    const firstRowHeader = bodyRows[0]?.querySelector('th[scope="row"]');
    expect(firstRowHeader?.textContent?.trim()).toBe('Ada Lovelace');
  });
});

describe('DataTable — data values', () => {
  test('all column values are rendered in each body row', () => {
    const { container } = render(DataTable, { columns, rows });
    const bodyRows = Array.from(container.querySelectorAll('tbody tr'));
    const firstRowCells = Array.from(bodyRows[0]?.querySelectorAll('th, td') ?? []);
    const texts = firstRowCells.map((cell) => cell.textContent?.trim());
    expect(texts).toContain('Ada Lovelace');
    expect(texts).toContain('Mathematician');
    expect(texts).toContain('142');
  });

  test('second row renders distinct values', () => {
    const { container } = render(DataTable, { columns, rows });
    const bodyRows = Array.from(container.querySelectorAll('tbody tr'));
    const secondRowCells = Array.from(bodyRows[1]?.querySelectorAll('th, td') ?? []);
    const texts = secondRowCells.map((cell) => cell.textContent?.trim());
    expect(texts).toContain('Grace Hopper');
    expect(texts).toContain('Computer Scientist');
    expect(texts).toContain('98');
  });

  test('column count matches between header and body rows', () => {
    const { container } = render(DataTable, { columns, rows });
    const headerCellCount = container.querySelectorAll('thead th').length;
    const bodyRows = Array.from(container.querySelectorAll('tbody tr'));
    for (const row of bodyRows) {
      const cellCount = row.querySelectorAll('th, td').length;
      expect(cellCount).toBe(headerCellCount);
    }
  });
});

describe('DataTable — row selection', () => {
  test('exports the row selection mode type from the public subpath barrel', () => {
    const mode: DataTableSelectionMode = 'multiple';
    expect(mode).toBe('multiple');
  });

  test('exports the row selection mode type from the root barrel', () => {
    const mode: RootDataTableSelectionMode = 'single';
    expect(mode).toBe('single');
  });

  test('multiple mode renders row checkboxes and updates a bound selectedRowIds array', async () => {
    let selectedRowIds: string[] = [];
    const { container } = render(DataTable, {
      columns,
      rows: rowsWithIds,
      selectable: 'multiple',
      get selectedRowIds() {
        return selectedRowIds;
      },
      set selectedRowIds(next: string[] | Set<string>) {
        selectedRowIds = Array.from(next);
      },
    });

    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]'),
    );
    expect(checkboxes).toHaveLength(rowsWithIds.length);

    await fireEvent.click(checkboxes[1]!);
    expect(selectedRowIds).toEqual(['grace']);
  });

  test('selected native rows do not emit invalid aria-selected attributes', () => {
    const { container } = render(DataTable, {
      columns,
      rows: rowsWithIds,
      selectable: 'multiple',
      selectedRowIds: ['grace'],
    });

    expect(bodyDataRows(container)[0]?.hasAttribute('aria-selected')).toBe(false);
    expect(bodyDataRows(container)[1]?.hasAttribute('aria-selected')).toBe(false);
  });

  test('select-all toggles every enabled row and reflects an indeterminate state', async () => {
    let selectedRowIds: string[] = ['ada'];
    const { container } = render(DataTable, {
      columns,
      rows: rowsWithIds,
      selectable: 'multiple',
      isRowSelectionDisabled: (row: DataTableRow) => row['id'] === 'alan',
      get selectedRowIds() {
        return selectedRowIds;
      },
      set selectedRowIds(next: string[] | Set<string>) {
        selectedRowIds = Array.from(next);
      },
    });

    const selectAll = container.querySelector<HTMLInputElement>('thead input[type="checkbox"]');
    expect(selectAll).not.toBeNull();
    await tick();
    expect(selectAll?.indeterminate).toBe(true);

    await fireEvent.click(selectAll!);
    expect(selectedRowIds).toEqual(['ada', 'grace']);

    await fireEvent.click(selectAll!);
    expect(selectedRowIds).toEqual([]);
  });

  test('single mode replaces the previous selected row id', async () => {
    let selectedRowIds = new Set(['ada']);
    const { container } = render(DataTable, {
      columns,
      rows: rowsWithIds,
      selectable: 'single',
      get selectedRowIds() {
        return selectedRowIds;
      },
      set selectedRowIds(next: string[] | Set<string>) {
        selectedRowIds = new Set(next);
      },
    });

    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]'),
    );
    await fireEvent.click(checkboxes[1]!);
    expect(Array.from(selectedRowIds)).toEqual(['grace']);
    expect(container.querySelector('thead input[type="checkbox"]')).toBeNull();
  });

  test('single mode labels the empty selection header cell', () => {
    const { container } = render(DataTable, {
      columns,
      rows: rowsWithIds,
      selectable: 'single',
    });

    const selectionHeader = container.querySelector<HTMLTableCellElement>(
      'thead th.cinder-table__header-cell--selection',
    );
    expect(selectionHeader?.getAttribute('aria-label')).toBe('Row selection');
  });

  test('disabled rows render disabled checkboxes and are excluded from select-all', async () => {
    let selectedRowIds: string[] = [];
    const { container } = render(DataTable, {
      columns,
      rows: rowsWithIds,
      selectable: 'multiple',
      isRowSelectionDisabled: (row: DataTableRow) => row['id'] === 'grace',
      get selectedRowIds() {
        return selectedRowIds;
      },
      set selectedRowIds(next: string[] | Set<string>) {
        selectedRowIds = Array.from(next);
      },
    });

    const disabledCheckbox = Array.from(
      container.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]'),
    ).find((input) => input.disabled);
    expect(disabledCheckbox?.getAttribute('aria-label')).toBe('Select Grace Hopper');

    const selectAll = container.querySelector<HTMLInputElement>('thead input[type="checkbox"]');
    await fireEvent.click(selectAll!);
    expect(selectedRowIds).toEqual(['ada', 'alan']);
  });

  test('select-all preserves disabled rows that were already selected', async () => {
    let selectedRowIds: string[] = ['grace'];
    const { container } = render(DataTable, {
      columns,
      rows: rowsWithIds,
      selectable: 'multiple',
      isRowSelectionDisabled: (row: DataTableRow) => row['id'] === 'grace',
      get selectedRowIds() {
        return selectedRowIds;
      },
      set selectedRowIds(next: string[] | Set<string>) {
        selectedRowIds = Array.from(next);
      },
    });

    const selectAll = container.querySelector<HTMLInputElement>('thead input[type="checkbox"]');
    await fireEvent.click(selectAll!);
    expect(selectedRowIds).toEqual(['grace', 'ada', 'alan']);

    await fireEvent.click(selectAll!);
    expect(selectedRowIds).toEqual(['grace']);
  });

  test('row selection labels tolerate undefined custom labels', () => {
    const { container } = render(DataTable, {
      columns,
      rows: rowsWithIds,
      selectable: 'multiple',
      rowSelectionLabel: (() => undefined) as never,
    });

    const firstCheckbox = container.querySelector<HTMLInputElement>('tbody input[type="checkbox"]');
    expect(firstCheckbox?.getAttribute('aria-label')).toBe('Select Ada Lovelace');
  });

  test('form reset keeps row checkbox state aligned with selectedRowIds', async () => {
    const form = document.createElement('form');
    document.body.append(form);
    let selectedRowIds: string[] = [];
    const { container } = render(DataTable, {
      target: form,
      props: {
        columns,
        rows: rowsWithIds,
        selectable: 'multiple',
        get selectedRowIds() {
          return selectedRowIds;
        },
        set selectedRowIds(next: string[] | Set<string>) {
          selectedRowIds = Array.from(next);
        },
      },
    });
    const firstCheckbox = container.querySelector<HTMLInputElement>('tbody input[type="checkbox"]');

    await fireEvent.click(firstCheckbox!);
    await tick();
    expect(selectedRowIds).toEqual(['ada']);
    expect(firstCheckbox?.checked).toBe(true);

    form.reset();
    await waitFor(() => expect(selectedRowIds).toEqual([]));
    await tick();

    expect(selectedRowIds).toEqual([]);
    expect(firstCheckbox?.checked).toBe(false);

    await fireEvent.click(firstCheckbox!);
    expect(selectedRowIds).toEqual(['ada']);
  });

  test('canceled form reset leaves row selection unchanged', async () => {
    const form = document.createElement('form');
    document.body.append(form);
    let selectedRowIds: string[] = [];
    render(DataTable, {
      target: form,
      props: {
        columns,
        rows: rowsWithIds,
        selectable: 'multiple',
        get selectedRowIds() {
          return selectedRowIds;
        },
        set selectedRowIds(next: string[] | Set<string>) {
          selectedRowIds = Array.from(next);
        },
      },
    });
    const firstCheckbox = form.querySelector<HTMLInputElement>('tbody input[type="checkbox"]');

    await fireEvent.click(firstCheckbox!);
    await tick();
    expect(selectedRowIds).toEqual(['ada']);

    form.addEventListener('reset', (event) => event.preventDefault());
    const timers = trackTimers();
    try {
      form.dispatchEvent(new Event('reset', { bubbles: true, cancelable: true }));
      await waitUntil(() => timers.active().size === 0, {
        message: 'the component finishes its form-reset timer',
      });
    } finally {
      timers.release();
    }

    await tick();

    expect(selectedRowIds).toEqual(['ada']);
    expect(firstCheckbox?.checked).toBe(true);
  });

  test('virtualized focused rows toggle selection with Space', async () => {
    let selectedRowIds: string[] = [];
    const { container } = render(DataTable, {
      columns,
      rows: rowsWithIds,
      selectable: 'multiple',
      virtualized: true,
      rowHeight: 20,
      height: '120px',
      get selectedRowIds() {
        return selectedRowIds;
      },
      set selectedRowIds(next: string[] | Set<string>) {
        selectedRowIds = Array.from(next);
      },
    });

    await waitFor(() => expect(bodyDataRows(container)).toHaveLength(rowsWithIds.length));
    const firstRow = bodyDataRows(container)[0]!;
    await fireEvent.keyDown(firstRow, { key: ' ' });
    expect(selectedRowIds).toEqual(['ada']);
  });
});

describe('DataTable — scrollable', () => {
  test('scrolls by default, in a box that fades at the inline end', () => {
    const { container } = render(DataTable, { columns, rows });
    const box = container.querySelector('.cinder-table-scroll');
    expect(box?.querySelector(':scope > table')).not.toBeNull();
    expect(box?.classList.contains('cinder-_scroll-fade-inline-end')).toBe(true);
  });

  test('scrollable=false does not add cinder-table-scroll class', () => {
    const { container } = render(DataTable, { columns, rows, scrollable: false });
    expect(container.querySelector('.cinder-table-scroll')).toBeNull();
  });

  test('scrollable=true wraps the table in a .cinder-table-scroll container', () => {
    const { container } = render(DataTable, { columns, rows, scrollable: true });
    const wrapper = container.querySelector('.cinder-table-scroll');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('table')).not.toBeNull();
  });
});

describe('DataTable — rest props', () => {
  test('forwards arbitrary HTML attributes to the root wrapper <div>', () => {
    const { container } = render(DataTable, {
      columns,
      rows,
      id: 'contributors',
      'data-testid': 'roster',
    });
    const wrapper = container.querySelector('.cinder-data-table');
    expect(wrapper?.getAttribute('id')).toBe('contributors');
    expect(wrapper?.getAttribute('data-testid')).toBe('roster');
    // The component's own class survives alongside the forwarded attributes.
    expect(wrapper?.classList.contains('cinder-data-table')).toBe(true);
  });

  test('forwards arbitrary HTML attributes to the scrollable wrapper <div>', () => {
    const { container } = render(DataTable, {
      columns,
      rows,
      scrollable: true,
      id: 'contributors',
    });
    const wrapper = container.querySelector('.cinder-table-scroll');
    expect(wrapper?.classList.contains('cinder-data-table')).toBe(true);
    expect(wrapper?.getAttribute('id')).toBe('contributors');
  });
});

describe('DataTable — density', () => {
  test('density prop is forwarded to the table element', () => {
    const { container } = render(DataTable, { columns, rows, density: 'condensed' });
    expect(container.querySelector('table')?.getAttribute('data-cinder-density')).toBe('condensed');
  });

  test('density defaults to comfortable', () => {
    const { container } = render(DataTable, { columns, rows });
    expect(container.querySelector('table')?.getAttribute('data-cinder-density')).toBe(
      'comfortable',
    );
  });
});

describe('DataTable — align mapping', () => {
  test('align="end" column header and body cell carry data-cinder-align="right"', () => {
    const { container } = render(DataTable, { columns, rows });
    // 'commits' column has align='end' → should map to 'right'
    const headerCells = Array.from(container.querySelectorAll('thead th'));
    expect(headerCells[2]?.getAttribute('data-cinder-align')).toBe('right');
    const bodyRows = Array.from(container.querySelectorAll('tbody tr'));
    const commitsCells = bodyRows.map((row) => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      return cells[2];
    });
    for (const cell of commitsCells) {
      expect(cell?.getAttribute('data-cinder-align')).toBe('right');
    }
  });

  test('align="start" column header and body cell carry data-cinder-align="left"', () => {
    const startColumns = [{ key: 'name', label: 'Name', align: 'start' as const }];
    const startRows = [{ name: 'Ada' }];
    const { container } = render(DataTable, { columns: startColumns, rows: startRows });
    const headerCell = container.querySelector('thead th');
    expect(headerCell?.getAttribute('data-cinder-align')).toBe('left');
  });
});

describe('DataTable — virtualized rows', () => {
  test('keeps virtualized table semantics and layout when initially empty', async () => {
    const view = render(DataTable, {
      columns,
      rows: [],
      virtualized: true,
      rowHeight: 20,
      height: '200px',
    });

    const wrapper = view.container.querySelector<HTMLElement>('.cinder-data-table');
    const table = view.container.querySelector('table');
    if (!wrapper || !table) throw new Error('Expected DataTable wrapper and table');

    expect(wrapper.classList.contains('cinder-table-scroll')).toBe(true);
    expect(wrapper.getAttribute('data-cinder-virtualized')).toBe('true');
    expect(wrapper.style.getPropertyValue('--cinder-data-table-height')).toBe('200px');
    expect(table.getAttribute('aria-rowcount')).toBe('1');
    expect(bodyDataRows(view.container)).toHaveLength(0);

    await view.rerender({
      columns,
      rows: makeRows(1),
      virtualized: true,
      rowHeight: 20,
      height: '200px',
    });

    await waitFor(() => expect(bodyDataRows(view.container)).toHaveLength(1));
    expect(bodyDataRows(view.container)[0]?.getAttribute('aria-rowindex')).toBe('2');
  });

  test('windows <tbody> rows while preserving table and header semantics', async () => {
    const manyRows = makeRows(10_000);
    const { container } = render(DataTable, {
      columns,
      rows: manyRows,
      virtualized: true,
      rowHeight: 20,
      height: '200px',
      overscan: 2,
    });

    await waitFor(() => expect(bodyDataRows(container).length).toBeGreaterThan(0));

    const table = container.querySelector('table');
    expect(table?.getAttribute('aria-rowcount')).toBe('10001');
    expect(container.querySelectorAll('thead th[scope="col"]')).toHaveLength(columns.length);
    expect(bodyDataRows(container).length).toBeLessThan(10_000 / 10);
    expect(bodyDataRows(container).length).toBeLessThanOrEqual(14);
    expect(bodyDataRows(container)[0]?.getAttribute('aria-rowindex')).toBe('2');
    expect(bodyDataRows(container)[0]?.querySelector('th[scope="row"]')?.textContent).toContain(
      'Person 0',
    );
  });

  test('scrolling renders the expected row window with full-dataset row indexes', async () => {
    const { container } = render(DataTable, {
      columns,
      rows: makeRows(1_000),
      virtualized: true,
      rowHeight: 20,
      height: '200px',
      overscan: 2,
    });

    const wrapper = container.querySelector<HTMLElement>('.cinder-data-table');
    if (!wrapper) throw new Error('Expected DataTable wrapper');

    wrapper.scrollTop = 1_000;
    await fireEvent.scroll(wrapper);

    await waitFor(() =>
      expect(bodyDataRows(container).some((row) => row.textContent?.includes('Person 50'))).toBe(
        true,
      ),
    );
    const row = bodyDataRows(container).find((element) =>
      element.textContent?.includes('Person 50'),
    );

    expect(row?.getAttribute('aria-rowindex')).toBe('52');
    expect(container.querySelector('table')?.getAttribute('aria-rowcount')).toBe('1001');
  });

  test('sticky virtualized headers map scroll offsets directly to the body window', async () => {
    const { container } = render(DataTable, {
      columns,
      rows: makeRows(1_000),
      stickyHeader: true,
      virtualized: true,
      rowHeight: 20,
      height: '200px',
      overscan: 0,
    });

    const wrapper = container.querySelector<HTMLElement>('.cinder-data-table');
    const header = container.querySelector<HTMLElement>('thead');
    if (!wrapper || !header) throw new Error('Expected DataTable wrapper and header');

    header.getBoundingClientRect = () => rectWithHeight(40);
    wrapper.scrollTop = 1_000;
    await fireEvent.scroll(wrapper);

    await waitFor(() => expect(bodyDataRows(container)[0]?.textContent).toContain('Person 50'));
    expect(bodyDataRows(container)[0]?.getAttribute('aria-rowindex')).toBe('52');
  });

  test('captioned virtualized tables subtract caption and header before windowing body rows', async () => {
    const { container } = render(DataTable, {
      columns,
      rows: makeRows(1_000),
      caption: 'Workflow log tail',
      virtualized: true,
      rowHeight: 20,
      height: '200px',
      overscan: 0,
    });

    const wrapper = container.querySelector<HTMLElement>('.cinder-data-table');
    const caption = container.querySelector<HTMLElement>('caption');
    const header = container.querySelector<HTMLElement>('thead');
    if (!wrapper || !caption || !header) {
      throw new Error('Expected DataTable wrapper, caption, and header');
    }

    caption.getBoundingClientRect = () => rectWithHeight(40);
    header.getBoundingClientRect = () => rectWithHeight(40);
    wrapper.scrollTop = 1_000;
    await fireEvent.scroll(wrapper);

    await waitFor(() => expect(bodyDataRows(container)[0]?.textContent).toContain('Person 46'));
    expect(bodyDataRows(container)[0]?.getAttribute('aria-rowindex')).toBe('48');
  });

  test('sticky captioned virtualized tables subtract caption but not the sticky header', async () => {
    const { container } = render(DataTable, {
      columns,
      rows: makeRows(1_000),
      caption: 'Workflow log tail',
      stickyHeader: true,
      virtualized: true,
      rowHeight: 20,
      height: '200px',
      overscan: 0,
    });

    const wrapper = container.querySelector<HTMLElement>('.cinder-data-table');
    const caption = container.querySelector<HTMLElement>('caption');
    const header = container.querySelector<HTMLElement>('thead');
    if (!wrapper || !caption || !header) {
      throw new Error('Expected DataTable wrapper, caption, and header');
    }

    caption.getBoundingClientRect = () => rectWithHeight(40);
    header.getBoundingClientRect = () => rectWithHeight(40);
    wrapper.scrollTop = 1_000;
    await fireEvent.scroll(wrapper);

    await waitFor(() => expect(bodyDataRows(container)[0]?.textContent).toContain('Person 48'));
    expect(bodyDataRows(container)[0]?.getAttribute('aria-rowindex')).toBe('50');
  });

  test('captioned virtualized tables keep stickToBottom pinned after append', async () => {
    const view = render(DataTable, {
      columns,
      rows: makeRows(100),
      caption: 'Workflow log tail',
      virtualized: true,
      rowHeight: 20,
      height: '200px',
      overscan: 0,
      stickToBottom: true,
    });

    const wrapper = view.container.querySelector<HTMLElement>('.cinder-data-table');
    const caption = view.container.querySelector<HTMLElement>('caption');
    const header = view.container.querySelector<HTMLElement>('thead');
    if (!wrapper || !caption || !header) {
      throw new Error('Expected DataTable wrapper, caption, and header');
    }

    caption.getBoundingClientRect = () => rectWithHeight(40);
    header.getBoundingClientRect = () => rectWithHeight(40);
    wrapper.scrollTop = 1_880;
    await fireEvent.scroll(wrapper);

    await view.rerender({
      columns,
      rows: makeRows(101),
      caption: 'Workflow log tail',
      virtualized: true,
      rowHeight: 20,
      height: '200px',
      overscan: 0,
      stickToBottom: true,
    });
    await tick();

    await waitFor(() => expect(wrapper.scrollTop).toBe(1_900));
    expect(bodyDataRows(view.container).at(-1)?.textContent).toContain('Person 100');
  });

  test('virtualized scrolling composes consumer onscroll with the internal window update', async () => {
    let scrollCallCount = 0;
    const { container } = render(DataTable, {
      columns,
      rows: makeRows(1_000),
      virtualized: true,
      rowHeight: 20,
      height: '200px',
      overscan: 0,
      onscroll: () => {
        scrollCallCount += 1;
      },
    });

    const wrapper = container.querySelector<HTMLElement>('.cinder-data-table');
    if (!wrapper) throw new Error('Expected DataTable wrapper');

    wrapper.scrollTop = 1_000;
    await fireEvent.scroll(wrapper);

    expect(scrollCallCount).toBe(1);
    await waitFor(() => expect(bodyDataRows(container)[0]?.textContent).toContain('Person 50'));
  });

  test('keyboard navigation scrolls an off-window row into view and keeps it reachable', async () => {
    const { container } = render(DataTable, {
      columns,
      rows: makeRows(200),
      virtualized: true,
      rowHeight: 20,
      height: '200px',
      overscan: 2,
    });

    const firstRow = bodyDataRows(container)[0];
    if (!firstRow) throw new Error('Expected first rendered data row');
    firstRow.focus();
    expect(document.activeElement).toBe(firstRow);

    await fireEvent.keyDown(firstRow, { key: 'End' });

    await waitFor(() =>
      expect(bodyDataRows(container).some((row) => row.textContent?.includes('Person 199'))).toBe(
        true,
      ),
    );
    const lastRow = bodyDataRows(container).find((row) => row.textContent?.includes('Person 199'));
    if (!lastRow) throw new Error('Expected last rendered data row');
    expect(lastRow?.getAttribute('aria-rowindex')).toBe('201');
    expect(lastRow?.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(lastRow);

    const wrapper = container.querySelector<HTMLElement>('.cinder-data-table');
    if (!wrapper) throw new Error('Expected DataTable wrapper');
    wrapper.scrollTop = 0;
    await fireEvent.scroll(wrapper);
    await waitFor(() =>
      expect(bodyDataRows(container).some((row) => row.textContent?.includes('Person 0'))).toBe(
        true,
      ),
    );
    expect(bodyDataRows(container)[0]?.getAttribute('tabindex')).toBe('0');

    wrapper.scrollTop = 3_800;
    await fireEvent.scroll(wrapper);
    await waitFor(() =>
      expect(bodyDataRows(container).some((row) => row.textContent?.includes('Person 199'))).toBe(
        true,
      ),
    );
    const restoredLastRow = bodyDataRows(container).find((row) =>
      row.textContent?.includes('Person 199'),
    );
    expect(restoredLastRow?.getAttribute('tabindex')).toBe('0');
  });

  test('Home returns a virtualized table to the top of the native scroll container', async () => {
    const { container } = render(DataTable, {
      columns,
      rows: makeRows(200),
      virtualized: true,
      rowHeight: 20,
      height: '200px',
      overscan: 0,
    });

    const wrapper = container.querySelector<HTMLElement>('.cinder-data-table');
    const header = container.querySelector<HTMLElement>('thead');
    const firstRow = bodyDataRows(container)[0];
    if (!wrapper || !header || !firstRow) {
      throw new Error('Expected DataTable wrapper, header, and first rendered row');
    }

    header.getBoundingClientRect = () => rectWithHeight(40);
    wrapper.scrollTop = 1_000;
    await fireEvent.scroll(wrapper);

    await waitFor(() =>
      expect(bodyDataRows(container).some((row) => row.textContent?.includes('Person 48'))).toBe(
        true,
      ),
    );
    const scrolledRow = bodyDataRows(container)[0];
    if (!scrolledRow) throw new Error('Expected scrolled rendered data row');

    scrolledRow.focus();
    await fireEvent.keyDown(scrolledRow, { key: 'Home' });

    await waitFor(() =>
      expect(bodyDataRows(container).some((row) => row.textContent?.includes('Person 0'))).toBe(
        true,
      ),
    );
    expect(wrapper.scrollTop).toBe(0);
    expect(bodyDataRows(container)[0]?.getAttribute('tabindex')).toBe('0');
  });
});

describe('DataTable — truncating columns', () => {
  const storageKey = `storage/${'segment-'.repeat(250)}`;

  test('a truncate column ellipsizes its text and keeps the full value in the title', () => {
    const { container } = render(DataTable, {
      columns: [
        { key: 'key', label: 'Key', truncate: true },
        { key: 'owner', label: 'Owner' },
      ],
      rows: [{ key: storageKey, owner: 'ops' }],
    });
    const truncated = container.querySelectorAll(
      'td[data-cinder-truncate], th[data-cinder-truncate]',
    );
    expect(truncated).toHaveLength(1);
    const text = truncated[0]?.querySelector('.cinder-table__cell-text');
    expect(text?.getAttribute('title')).toBe(storageKey);

    // A column without the option is untouched.
    const owner = Array.from(container.querySelectorAll('tbody td')).find(
      (cell) => cell.textContent?.trim() === 'ops',
    );
    expect(owner?.hasAttribute('data-cinder-truncate')).toBe(false);
    expect(owner?.querySelector('.cinder-table__cell-text')).toBeNull();
  });
});

describe('DataTable — a truncating column with a maxWidth', () => {
  test('the widest its text grows is the column\u2019s maxWidth, and no other column is given one', () => {
    const { container } = render(DataTable, {
      columns: [
        { key: 'key', label: 'Key', truncate: true, maxWidth: 288 },
        { key: 'owner', label: 'Owner', truncate: true },
        { key: 'size', label: 'Size', maxWidth: 80 },
      ],
      rows: [{ key: 'storage/a', owner: 'ops', size: '1 KB' }],
    });
    const cells = container.querySelectorAll<HTMLElement>('tbody td, tbody th');
    expect(cells[0]?.style.getPropertyValue('--_cinder-table-truncate-size')).toBe('288px');
    // Without a maxWidth the table's own limit stands, and a column that does not truncate has none to set.
    expect(cells[1]?.style.getPropertyValue('--_cinder-table-truncate-size')).toBe('');
    expect(cells[2]?.style.getPropertyValue('--_cinder-table-truncate-size')).toBe('');
  });
});

describe('DataTable — cells, row messages, groups and footer', () => {
  const toolColumns = [
    { key: 'on', label: 'On', controls: 'fit' as const },
    { key: 'name', label: 'Tool', monospace: true },
    { key: 'risk', label: 'Risk' },
  ];
  const toolRows = [
    { id: 'lookup', on: true, name: 'Lookup order', risk: 'Reads', failed: false },
    { id: 'refund', on: true, name: 'Issue refund', risk: 'Dangerous', failed: true },
  ];

  test('the cell snippet draws the content of every cell and controls mark their columns', () => {
    const { container } = render(SnippetsFixture, {
      columns: toolColumns,
      rows: toolRows,
      withCell: true,
    });
    expect(container.querySelectorAll('tbody input[type="checkbox"]')).toHaveLength(2);
    expect(container.querySelector('tbody [data-cinder-controls="fit"]')).not.toBeNull();
    expect(container.querySelector('tbody [data-cinder-monospace]')?.textContent).toContain(
      'Lookup order',
    );
  });

  test('a monospace column is set in the regular weight, even as the row header the browser makes bold', () => {
    const css = readFileSync(new URL('./data-table.css', import.meta.url), 'utf8');
    expect(css).toMatch(
      /\[data-cinder-monospace\]\s*\{[^}]*font-family: var\(--cinder-font-mono\);[^}]*font-weight: var\(--cinder-font-normal\)/s,
    );
  });

  test('a row message is its own full-width row under the row it belongs to', () => {
    const { container } = render(SnippetsFixture, {
      columns: toolColumns,
      rows: toolRows,
      withMessage: true,
    });
    const messages = container.querySelectorAll('tr.cinder-data-table__row-message');
    expect(messages).toHaveLength(1);
    const cell = messages[0]?.querySelector('td');
    expect(cell?.getAttribute('colspan')).toBe('3');
    expect(cell?.textContent).toContain('Couldn’t save Issue refund.');
    expect(cell?.querySelector('[role="alert"]')).not.toBeNull();
    // It follows the row it reports on, and that row is marked.
    expect(messages[0]?.previousElementSibling?.textContent).toContain('Issue refund');
    expect(messages[0]?.previousElementSibling?.hasAttribute('data-cinder-message')).toBe(true);
    expect(container.querySelectorAll('tbody tr[data-cinder-message]')).toHaveLength(1);
  });

  test('every row has a message when no predicate narrows them', () => {
    const { container } = render(SnippetsFixture, {
      columns: toolColumns,
      rows: toolRows.map((row) => ({ ...row, failed: true })),
      withMessage: true,
    });
    expect(container.querySelectorAll('tr.cinder-data-table__row-message')).toHaveLength(2);
  });

  test('groupBy opens each run of rows with a header row that names the zone', () => {
    const { container } = render(DataTable, {
      columns: [
        { key: 'when', label: 'When' },
        { key: 'what', label: 'What' },
      ],
      rows: [
        { id: '1', day: 'today', when: '10:45 AM', what: 'Removed the key' },
        { id: '2', day: 'today', when: '9:00 AM', what: 'Server started' },
        { id: '3', day: 'yesterday', when: '4:12 PM', what: 'Deleted a chat' },
      ],
      groupBy: (row: DataTableRow) =>
        row['day'] === 'today'
          ? { key: 'today', label: 'Today, Nov 2', detail: 'Central time' }
          : { key: 'yesterday', label: 'Yesterday, Sun Nov 1', detail: 'Central time' },
    });
    const groups = Array.from(container.querySelectorAll('tr.cinder-data-table__group-row'));
    expect(groups.map((group) => group.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Today, Nov 2, Central time',
      'Yesterday, Sun Nov 1, Central time',
    ]);
    expect(groups[0]?.querySelector('th')?.getAttribute('scope')).toBe('colgroup');
    expect(groups[0]?.querySelector('th')?.getAttribute('colspan')).toBe('2');
    // The header sits before its first row, and the second run follows the first.
    expect(groups[0]?.nextElementSibling?.textContent).toContain('Removed the key');
    expect(groups[1]?.previousElementSibling?.textContent).toContain('Server started');
  });

  test('a group key that comes back after another group opens a new header', () => {
    const { container } = render(DataTable, {
      columns: [{ key: 'what', label: 'What' }],
      rows: [
        { id: '1', g: 'a', what: 'one' },
        { id: '2', g: 'b', what: 'two' },
        { id: '3', g: 'a', what: 'three' },
      ],
      groupBy: (row: DataTableRow) => ({ key: String(row['g']), label: String(row['g']) }),
    });
    expect(container.querySelectorAll('tr.cinder-data-table__group-row')).toHaveLength(3);
  });

  test('the footer spans the table below the last row', () => {
    const { container } = render(SnippetsFixture, {
      columns: toolColumns,
      rows: toolRows,
      withFooter: true,
    });
    const cell = container.querySelector('tfoot .cinder-data-table__footer-cell');
    expect(cell?.getAttribute('colspan')).toBe('3');
    expect(cell?.textContent?.trim()).toBe('Showing 2 events.');
  });

  test('rows carry their id so a list-and-detail pane can find them', () => {
    const { container } = render(DataTable, { columns, rows: rowsWithIds });
    expect(
      Array.from(container.querySelectorAll('tbody tr')).map((row) =>
        row.getAttribute('data-cinder-row-id'),
      ),
    ).toEqual(['ada', 'grace', 'alan']);
  });
});

describe('DataTable — rows that open', () => {
  test('a click opens the row, and a click on a control in the row does not', async () => {
    const opened: string[] = [];
    const { container } = render(SnippetsFixture, {
      columns: [
        { key: 'on', label: 'On', controls: 'fit' as const },
        { key: 'name', label: 'Tool' },
      ],
      rows: [{ id: 'lookup', on: true, name: 'Lookup order' }],
      withCell: true,
      onRowOpen: (row: DataTableRow) => opened.push(String(row['id'])),
    });
    await fireEvent.click(container.querySelector('tbody td:last-child')!);
    expect(opened).toEqual(['lookup']);
    await fireEvent.click(container.querySelector('tbody input[type="checkbox"]')!);
    expect(opened).toEqual(['lookup']);
  });

  test('rows are one tab stop, Enter and Space open, the arrows move, and the open row is current', async () => {
    const opened: string[] = [];
    const { container } = render(DataTable, {
      columns,
      rows: rowsWithIds,
      openRowId: 'grace',
      onRowOpen: (row: DataTableRow) => opened.push(String(row['id'])),
    });
    const bodyRows = bodyDataRows(container);
    expect(bodyRows.map((row) => row.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(bodyRows.map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true', null]);
    expect(bodyRows[1]?.hasAttribute('data-cinder-open')).toBe(true);

    bodyRows[0]!.focus();
    await fireEvent.keyDown(bodyRows[0]!, { key: 'Enter' });
    await fireEvent.keyDown(bodyRows[0]!, { key: ' ' });
    expect(opened).toEqual(['ada', 'ada']);

    await fireEvent.keyDown(bodyRows[0]!, { key: 'ArrowDown' });
    await tick();
    expect(document.activeElement).toBe(bodyRows[1]!);
    await fireEvent.keyDown(bodyRows[1]!, { key: 'End' });
    await tick();
    expect(document.activeElement).toBe(bodyRows[2]!);
  });

  test('a table without onRowOpen has no tab stops on its rows', () => {
    const { container } = render(DataTable, { columns, rows: rowsWithIds });
    expect(bodyDataRows(container).every((row) => !row.hasAttribute('tabindex'))).toBe(true);
  });
});

describe('DataTable — loading more by scrolling', () => {
  type ObserverRecord = {
    callback: IntersectionObserverCallback;
    target: Element | null;
    disconnected: boolean;
  };
  const records: ObserverRecord[] = [];
  const original = globalThis.IntersectionObserver;

  class StubIntersectionObserver {
    record: ObserverRecord;
    constructor(callback: IntersectionObserverCallback) {
      this.record = { callback, target: null, disconnected: false };
      records.push(this.record);
    }
    observe(target: Element): void {
      this.record.target = target;
    }
    unobserve(): void {}
    disconnect(): void {
      this.record.disconnected = true;
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  afterEach(() => {
    records.length = 0;
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: original,
    });
  });

  function install(): void {
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: StubIntersectionObserver,
    });
  }

  function reach(record: ObserverRecord): void {
    record.callback(
      [{ isIntersecting: true, target: record.target! } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  }

  test('asks for more when the end of the table scrolls into view, without a button', () => {
    install();
    let requests = 0;
    const { container } = render(DataTable, {
      columns,
      rows: rowsWithIds,
      onReachEnd: () => (requests += 1),
    });
    expect(container.querySelector('tfoot .cinder-data-table__end')).not.toBeNull();
    expect(container.querySelector('tfoot button')).toBeNull();
    const live = records.filter((record) => !record.disconnected);
    expect(live).toHaveLength(1);
    expect(live[0]?.target?.classList.contains('cinder-data-table__end')).toBe(true);

    reach(live[0]!);
    expect(requests).toBe(1);
  });

  test('watches again after the rows grow, so an end still in view asks again', async () => {
    install();
    let requests = 0;
    const { rerender } = render(DataTable, {
      columns,
      rows: rowsWithIds,
      onReachEnd: () => (requests += 1),
    });
    await rerender({
      columns,
      rows: [...rowsWithIds, { id: 'x', name: 'X', role: 'r', commits: 1 }],
      onReachEnd: () => (requests += 1),
    });
    await tick();
    const live = records.filter((record) => !record.disconnected);
    expect(live).toHaveLength(1);
    expect(records.length).toBeGreaterThan(1);
    reach(live[0]!);
    expect(requests).toBe(1);
  });

  test('draws no end marker without onReachEnd or a footer', () => {
    const { container } = render(DataTable, { columns, rows: rowsWithIds });
    expect(container.querySelector('tfoot')).toBeNull();
  });
});
