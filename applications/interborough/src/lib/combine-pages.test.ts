/**
 * `combinePages` joins the pages of an offset-paged query into one list of rows. A list that
 * shifts while it is being read (a record created between two page reads) hands the next page a
 * row the previous one already gave, and a keyed `{#each}` over the repeat throws.
 */
import { describe, expect, test } from 'bun:test';

import { combinePages } from './combine-pages.ts';

interface Row {
  readonly id: string;
  readonly note?: string;
}

const rowsOf = (page: { readonly rows: readonly Row[] }) => page.rows;
const keyOf = (row: Row) => row.id;

describe('combinePages', () => {
  test('is empty before any page has loaded', () => {
    expect(combinePages(undefined, rowsOf, keyOf)).toEqual([]);
    expect(combinePages([], rowsOf, keyOf)).toEqual([]);
  });

  test('appends the pages in order', () => {
    const pages = [{ rows: [{ id: 'a' }, { id: 'b' }] }, { rows: [{ id: 'c' }] }];
    expect(combinePages(pages, rowsOf, keyOf).map(keyOf)).toEqual(['a', 'b', 'c']);
  });

  test('drops a row whose key an earlier page already gave, and keeps the first', () => {
    const pages = [
      { rows: [{ id: 'a', note: 'first' }, { id: 'b' }] },
      { rows: [{ id: 'b', note: 'again' }, { id: 'c' }] },
    ];
    const combined = combinePages(pages, rowsOf, keyOf);
    expect(combined.map(keyOf)).toEqual(['a', 'b', 'c']);
    expect(combined.find((row) => row.id === 'b')?.note).toBeUndefined();
  });

  test('drops a repeat inside one page, and a key that reappears after other pages', () => {
    const pages = [
      { rows: [{ id: 'a' }, { id: 'a' }] },
      { rows: [{ id: 'b' }] },
      { rows: [{ id: 'a' }] },
    ];
    expect(combinePages(pages, rowsOf, keyOf).map(keyOf)).toEqual(['a', 'b']);
  });
});
