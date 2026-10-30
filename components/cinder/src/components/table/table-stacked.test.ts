/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { flushSync, tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { stripCinderComponentsLayer } from '../../test/css.ts';
import { DEFAULT_TEST_VIEWPORT, setTestViewportWidth } from '../../test/viewport.ts';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: Wrapper } = await import('../../test/fixtures/table-fixture.svelte');
const { default: DescriptionList } = await import('../description-list/description-list.svelte');

afterEach(() => {
  setTestViewportWidth(DEFAULT_TEST_VIEWPORT.width);
});

const columns = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'status', label: 'Status' },
];
const rows = [
  { id: '1', cells: ['Refund order 4471', 'Waiting on you'] },
  { id: '2', cells: ['Daily summary', 'Done'] },
];

function bodyCells(container: Element): HTMLTableCellElement[] {
  return Array.from(container.querySelectorAll<HTMLTableCellElement>('tbody td'));
}

describe('Table stackBelow', () => {
  test('stacks below 640px and labels each body cell with its column header', () => {
    setTestViewportWidth(375);
    const { container } = render(Wrapper, { columns, rows });
    flushSync();

    const table = container.querySelector('table');
    expect(table?.hasAttribute('data-cinder-stacked')).toBe(true);
    expect(
      bodyCells(container).map((cell) => cell.getAttribute('data-cinder-stack-label')),
    ).toEqual(['Name', 'Status', 'Name', 'Status']);
  });

  test('keeps the table layout at tablet and desktop widths', () => {
    setTestViewportWidth(768);
    const { container } = render(Wrapper, { columns, rows });
    flushSync();

    expect(container.querySelector('table')?.hasAttribute('data-cinder-stacked')).toBe(false);
    expect(container.querySelector('[data-cinder-stack-label]')).toBeNull();
  });

  test('follows the viewport across the breakpoint', async () => {
    const { container } = render(Wrapper, { columns, rows });
    const table = container.querySelector('table');
    expect(table?.hasAttribute('data-cinder-stacked')).toBe(false);

    setTestViewportWidth(375);
    await waitUntil(() => table?.hasAttribute('data-cinder-stacked') === true);
    expect(bodyCells(container)[1]?.getAttribute('data-cinder-stack-label')).toBe('Status');

    setTestViewportWidth(1024);
    await waitUntil(() => table?.hasAttribute('data-cinder-stacked') === false);
  });

  test('labels rows added while stacked', async () => {
    setTestViewportWidth(375);
    const { container, rerender } = render(Wrapper, { columns, rows });
    flushSync();

    await rerender({ columns, rows: [...rows, { id: '3', cells: ['Weekly report', 'Failed'] }] });
    await tick();
    await waitUntil(() => bodyCells(container).length === 6);
    await waitUntil(
      () => bodyCells(container)[5]?.getAttribute('data-cinder-stack-label') === 'Status',
    );
  });

  test('skips the label for a header cell with no text, such as the selection column', () => {
    setTestViewportWidth(375);
    const { container } = render(Wrapper, { columns, rows, selectable: true });
    flushSync();

    const firstRowCells = Array.from(
      container.querySelectorAll<HTMLTableCellElement>('tbody tr:first-child > *'),
    );
    expect(firstRowCells.map((cell) => cell.getAttribute('data-cinder-stack-label'))).toEqual([
      null,
      'Name',
      'Status',
    ]);
  });

  test('keeps explicit table roles while stacked and removes them after', async () => {
    // Start wide: happy-dom never fires `change` on a MediaQueryList created
    // while it already matches, so a table mounted narrow would never see the
    // viewport widen again. Browsers do not share the quirk.
    const { container } = render(Wrapper, { columns, rows });
    const table = container.querySelector('table');
    expect(table?.hasAttribute('role')).toBe(false);

    setTestViewportWidth(375);
    await waitUntil(() => table?.hasAttribute('data-cinder-stacked') === true);
    expect(table?.getAttribute('role')).toBe('table');
    expect(container.querySelector('thead')?.getAttribute('role')).toBe('rowgroup');
    expect(container.querySelector('tbody tr')?.getAttribute('role')).toBe('row');
    expect(container.querySelector('thead th')?.getAttribute('role')).toBe('columnheader');
    expect(container.querySelector('tbody td')?.getAttribute('role')).toBe('cell');

    setTestViewportWidth(1024);
    await waitUntil(() => table?.hasAttribute('data-cinder-stacked') === false);
    expect(container.querySelector('[role="cell"], [role="row"], [role="table"]')).toBeNull();
  });

  test('stackBelow={false} keeps the table layout on a phone', () => {
    setTestViewportWidth(375);
    const { container } = render(Wrapper, { columns, rows, stackBelow: false });
    flushSync();

    expect(container.querySelector('table')?.hasAttribute('data-cinder-stacked')).toBe(false);
  });

  test('a custom stackBelow moves the breakpoint', () => {
    setTestViewportWidth(768);
    const { container } = render(Wrapper, { columns, rows, stackBelow: '1024px' });
    flushSync();

    expect(container.querySelector('table')?.hasAttribute('data-cinder-stacked')).toBe(true);
  });

  test('rejects a stackBelow that is not a CSS length', () => {
    expect(() => render(Wrapper, { columns, rows, stackBelow: 'phone' })).toThrow(
      'Table stackBelow must be a CSS length such as "640px", or false.',
    );
  });

  test('the stacked styles hide the header from layout and put each label above its value', async () => {
    const css = stripCinderComponentsLayer(
      await Bun.file(new URL('./table.css', import.meta.url)).text(),
    );
    expect(css).toMatch(
      /\.cinder-table\[data-cinder-stacked\] > \.cinder-table__header \{[^}]*clip-path: inset\(50%\);/,
    );
    expect(css).toMatch(
      /\.cinder-table\[data-cinder-stacked\] \.cinder-table__cell\[data-cinder-stack-label\]::before \{\s*content: attr\(data-cinder-stack-label\);\s*display: block;/,
    );
    expect(css).toMatch(
      /\.cinder-table-scroll \.cinder-table\[data-cinder-stacked\] \{\s*min-inline-size: 0;/,
    );
  });
});

describe('DescriptionList stack', () => {
  const items = [
    { term: 'Order ID', definition: '4471' },
    { term: 'Reason', definition: 'Damaged' },
  ];

  test('marks the list stacked only when asked', () => {
    const stacked = render(DescriptionList, { items, variant: 'two-column', stack: true });
    expect(stacked.container.querySelector('dl')?.hasAttribute('data-cinder-stacked')).toBe(true);

    const sideBySide = render(DescriptionList, { items, variant: 'two-column' });
    expect(sideBySide.container.querySelector('dl')?.hasAttribute('data-cinder-stacked')).toBe(
      false,
    );
  });

  test('collapses the two-column grid to one column when stacked', async () => {
    const css = stripCinderComponentsLayer(
      await Bun.file(new URL('../description-list/description-list.css', import.meta.url)).text(),
    );
    expect(css).toMatch(
      /\.cinder-description-list\[data-cinder-variant='two-column'\]\[data-cinder-stacked\]\s+\.cinder-description-list__row \{\s*grid-template-columns: 1fr;/,
    );
  });
});
