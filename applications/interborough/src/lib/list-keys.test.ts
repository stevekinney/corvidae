import { describe, expect, test } from 'bun:test';

import { keyedByOccurrence } from './list-keys.ts';

describe('keyedByOccurrence', () => {
  test('gives records that share a base distinct keys, numbered in list order', () => {
    const keyed = keyedByOccurrence(['a', 'b', 'a', 'a'], (value) => value);
    expect(keyed.map((entry) => entry.key)).toEqual(['a#0', 'b#0', 'a#1', 'a#2']);
    expect(new Set(keyed.map((entry) => entry.key)).size).toBe(4);
  });

  test('keeps every item, in order', () => {
    const items = [{ id: 1 }, { id: 1 }, { id: 2 }];
    expect(keyedByOccurrence(items, (item) => String(item.id)).map((entry) => entry.item)).toEqual(
      items,
    );
  });

  test('a record keeps its key when the same sequence comes back', () => {
    const first = keyedByOccurrence(['x', 'x'], (value) => value);
    const again = keyedByOccurrence(['x', 'x'], (value) => value);
    expect(again).toEqual(first);
  });

  test('an empty list has no keys', () => {
    expect(keyedByOccurrence([], () => 'k')).toEqual([]);
  });
});
