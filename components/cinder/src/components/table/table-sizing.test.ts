/// <reference lib="dom" />
/**
 * COR-2769: a `fit` Table sizes a `content` column to its content and gives a `fill` column what
 * is left. The header cell's `sizing` reaches every body cell in its column, and a table with no
 * `sizing` keeps the fixed layout that shares the width equally.
 */
import { describe, expect, test } from 'bun:test';
import { flushSync } from 'svelte';

import { declarationsFor } from '@lostgradient/component-tooling/test/css.ts';
import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: SizingFixture } = await import('./table-sizing.fixture.svelte');

const css = await Bun.file(new URL('./table.css', import.meta.url)).text();

function sizings(container: Element, selector: string): (string | null)[] {
  return Array.from(container.querySelectorAll(selector), (cell) =>
    cell.getAttribute('data-cinder-sizing'),
  );
}

describe('Table column sizing', () => {
  test('each body cell takes the sizing of the header cell above it', () => {
    const { container } = render(SizingFixture, {});
    flushSync();
    expect(sizings(container, 'thead th')).toEqual(['content', 'content', 'fill']);
    for (const row of Array.from(container.querySelectorAll('tbody tr'))) {
      expect(sizings(row, ':scope > *')).toEqual(['content', 'content', 'fill']);
    }
  });

  test('a cell that spans columns belongs to none of them', () => {
    const { container } = render(SizingFixture, { spanning: true });
    flushSync();
    expect(container.querySelector('td[colspan="3"]')?.hasAttribute('data-cinder-sizing')).toBe(
      false,
    );
  });

  test('a table with no sizing marks no cell', () => {
    const { container } = render(SizingFixture, { unsized: true });
    flushSync();
    expect(container.querySelectorAll('[data-cinder-sizing]')).toHaveLength(0);
  });

  test('only a table that sets sizing leaves the fixed layout', () => {
    expect(declarationsFor(css, '.cinder-table[data-cinder-fit]').get('table-layout')).toBe(
      'fixed',
    );
    expect(
      declarationsFor(
        css,
        '.cinder-table[data-cinder-fit]:has(> .cinder-table__header [data-cinder-sizing])',
      ).get('table-layout'),
    ).toBe('auto');
    // The scroll box is a size container so a content column can be capped at half its width.
    expect(
      declarationsFor(
        css,
        '.cinder-table-scroll:has( > .cinder-table[data-cinder-fit] > .cinder-table__header [data-cinder-sizing] )',
      ).get('container-type'),
    ).toBe('inline-size');
  });

  test('a content column takes its content width, at most half the table, and never wraps', () => {
    const content = declarationsFor(
      css,
      ".cinder-table[data-cinder-fit]:not([data-cinder-stacked]) :is(.cinder-table__cell, .cinder-table__header-cell)[data-cinder-sizing='content']",
    );
    expect(content.get('inline-size')).toBe('0');
    expect(content.get('max-inline-size')).toBe('50cqi');
    expect(content.get('white-space')).toBe('nowrap');
  });

  test('a fill column, and an unsized one beside content columns, breaks anywhere', () => {
    const fill = declarationsFor(
      css,
      ".cinder-table[data-cinder-fit]:not([data-cinder-stacked]):has( > .cinder-table__header [data-cinder-sizing] ) :is(.cinder-table__cell, .cinder-table__header-cell):not([data-cinder-sizing='content'])",
    );
    expect(fill.get('overflow-wrap')).toBe('anywhere');
    // A truncating cell asks for no width, then fills its column and ends in an ellipsis.
    const truncated = declarationsFor(
      css,
      ".cinder-table[data-cinder-fit]:not([data-cinder-stacked]):has( > .cinder-table__header [data-cinder-sizing] ) .cinder-table__cell:not([data-cinder-sizing='content']) .cinder-table__cell-text",
    );
    expect(truncated.get('inline-size')).toBe('0');
    expect(truncated.get('min-inline-size')).toBe('100%');
    // Prose in a fill column keeps the readable measure.
    expect(
      declarationsFor(
        css,
        '.cinder-table[data-cinder-fit]:not([data-cinder-stacked]) .cinder-table__cell-prose',
      ).get('max-inline-size'),
    ).toBe('var(--cinder-content-width-prose)');
  });

  test('a content cell cuts a long value with an ellipsis, and a fill cell holds its prose to a measure', () => {
    const { container } = render(SizingFixture, {});
    flushSync();
    const firstRow = container.querySelector('tbody tr');
    const [check, result, found] = Array.from(firstRow?.children ?? []);
    // Content cells take the truncate path: one line of text that ends in an ellipsis when cut.
    expect(check?.querySelector(':scope > .cinder-table__cell-text')).not.toBeNull();
    expect(result?.querySelector(':scope > .cinder-table__cell-text')).not.toBeNull();
    // A content cell is not marked `truncate`: that is the caller's prop, not the column's.
    expect(result?.hasAttribute('data-cinder-truncate')).toBe(false);
    expect(found?.querySelector(':scope > .cinder-table__cell-prose')?.textContent).toContain(
      'port 7233',
    );
  });
});
