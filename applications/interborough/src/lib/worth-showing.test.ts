import { describe, expect, test } from 'bun:test';

import { countIsWorthShowing, countsWorthShowing, listIsClear } from './worth-showing.ts';

// Owner, 2026-11-19: a tile shows only when its count is not zero, and no card says nothing.
describe('what a summary shows', () => {
  test('a count is a tile above zero, or when it could not be read', () => {
    expect(countIsWorthShowing({ value: 3 })).toBe(true);
    expect(countIsWorthShowing({ value: null })).toBe(true);
    expect(countIsWorthShowing({ value: 0 })).toBe(false);
    expect(countIsWorthShowing({ value: undefined })).toBe(false);
  });

  test('every count at zero leaves no tile row, and the order given is kept', () => {
    expect(countsWorthShowing([{ value: 0 }, { value: 0 }, { value: 0 }])).toEqual([]);
    const shown = countsWorthShowing([
      { key: 'a', value: 0 },
      { key: 'b', value: 2 },
      { key: 'c', value: null },
    ]);
    expect(shown.map((count) => count.key)).toEqual(['b', 'c']);
  });

  test('a list is clear only once it has answered with nothing in it', () => {
    expect(listIsClear([])).toBe(true);
    expect(listIsClear(undefined)).toBe(false);
    expect(listIsClear([1])).toBe(false);
  });
});
