/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: Fixture } = await import('../../test/fixtures/table-header-cell-fixture.svelte');

describe('TableHeaderCell', () => {
  test('reserves sortable header space for adjacent actions', () => {
    const componentCss = readFileSync(new URL('./table-header-cell.css', import.meta.url), 'utf8');
    const tableCss = readFileSync(new URL('../table/table.css', import.meta.url), 'utf8');
    const sortButtonRule = tableCss.split('.cinder-table__sort-button {')[1]?.split('}')[0];

    expect(componentCss).toMatch(/\.cinder-table__header-content\s*\{[\s\S]*display:\s*flex;/);
    expect(componentCss).toMatch(/\.cinder-table__header-actions\s*\{[\s\S]*flex:\s*0\s+0\s+auto;/);
    expect(sortButtonRule).toContain('flex: 1 1 auto;');
    expect(sortButtonRule).toContain('min-width: 0;');
  });

  // COR-2769: `sizing` reaches the header cell as an attribute only when it is set.
  test.each(['content', 'fill'] as const)('sizing="%s" marks the header cell', (sizing) => {
    const { container } = render(Fixture, { headerCellProps: { sizing } });
    expect(container.querySelector('th')?.getAttribute('data-cinder-sizing')).toBe(sizing);
  });

  // COR-2771: the label is required, so an untyped caller that leaves it out fails at once.
  test('a header cell without a label throws', () => {
    expect(() =>
      render(Fixture, { headerCellProps: { label: undefined as unknown as string } }),
    ).toThrow('Table.HeaderCell requires a label');
  });

  test('a header cell carries its label for the stacked cells under it', () => {
    const { container } = render(Fixture, {});
    expect(container.querySelector('th')?.getAttribute('data-cinder-label')).toBe('Commits');
    expect(container.querySelector('tbody td')?.getAttribute('data-cinder-stack-label')).toBe(
      'Commits',
    );
  });

  test('a header cell without sizing carries no sizing attribute', () => {
    const { container } = render(Fixture, {});
    expect(container.querySelector('th')?.hasAttribute('data-cinder-sizing')).toBe(false);
  });

  test('align defaults to left', () => {
    const { container } = render(Fixture, {});
    expect(container.querySelector('th')?.getAttribute('data-cinder-align')).toBe('left');
  });

  test('align="right" reflects on the header cell', () => {
    const { container } = render(Fixture, { align: 'right' });
    expect(container.querySelector('th')?.getAttribute('data-cinder-align')).toBe('right');
  });

  test('align="right" reflects on sortable header cells', () => {
    const { container } = render(Fixture, { align: 'right', sortable: true });
    const headerCell = container.querySelector('th');
    expect(headerCell?.getAttribute('data-cinder-align')).toBe('right');
    expect(headerCell?.querySelector('.cinder-table__sort-button')).not.toBeNull();
  });

  test('keeps non-sortable center and right headers aligned with their cells', () => {
    const componentCss = readFileSync(new URL('./table-header-cell.css', import.meta.url), 'utf8');
    expect(componentCss).toMatch(
      /data-cinder-align='center'[^}]*header-content[\s\S]*justify-content:\s*center/,
    );
    expect(componentCss).toMatch(
      /data-cinder-align='right'[^}]*header-content[\s\S]*justify-content:\s*flex-end/,
    );
  });

  test('forwards native th attributes (colspan, id, data-*) to the rendered <th>', () => {
    const { container } = render(Fixture, {
      headerCellProps: { colspan: 2, id: 'header-1', 'data-testid': 'my-header' },
    });
    const headerCell = container.querySelector('th');
    expect(headerCell?.getAttribute('colspan')).toBe('2');
    expect(headerCell?.getAttribute('id')).toBe('header-1');
    expect(headerCell?.getAttribute('data-testid')).toBe('my-header');
  });

  test('component-computed aria-sort cannot be clobbered by rest spread', () => {
    // aria-sort is a derived value computed from table context — it is placed AFTER
    // the {...rest} spread on the <th>, so the component's value always wins.
    const { container } = render(Fixture, {
      sortable: true,
      // `aria-sort` is Omit-ted from the prop type (component-owned), so the props
      // object is cast to inject it the way an untyped JS consumer could.
      headerCellProps: {
        // Attempt to override the computed aria-sort via rest
        'aria-sort': 'descending',
      } as never,
    });
    const headerCell = container.querySelector('th');
    // aria-sort is computed from table context (no sort active → 'none' for a sortable col).
    // The component's explicit binding comes after the spread, so it cannot be overridden.
    expect(headerCell?.getAttribute('aria-sort')).toBe('none');
    // The cinder class must always be present.
    expect(headerCell?.classList.contains('cinder-table__header-cell')).toBe(true);
  });
});
