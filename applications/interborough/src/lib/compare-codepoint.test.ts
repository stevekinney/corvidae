/** Tests for `compareCodepoint`: the three outcomes and the codepoint (not locale) order. */
import { describe, expect, it } from 'bun:test';

import { compareCodepoint } from './compare-codepoint.ts';

describe('compareCodepoint', () => {
  it('orders the lesser string first, the greater last, and equal strings as ties', () => {
    expect(compareCodepoint('alpha', 'beta')).toBe(-1);
    expect(compareCodepoint('beta', 'alpha')).toBe(1);
    expect(compareCodepoint('alpha', 'alpha')).toBe(0);
  });

  it('sorts by codepoint, so every uppercase letter precedes every lowercase one', () => {
    expect(['send-invoice', 'Archive', 'reconcile', 'Zulu'].toSorted(compareCodepoint)).toEqual([
      'Archive',
      'Zulu',
      'reconcile',
      'send-invoice',
    ]);
  });

  it('is stable for equal keys, which compare as ties', () => {
    const rows = [
      { name: 'b', order: 0 },
      { name: 'a', order: 1 },
      { name: 'b', order: 2 },
    ];
    expect(rows.toSorted((left, right) => compareCodepoint(left.name, right.name))).toEqual([
      { name: 'a', order: 1 },
      { name: 'b', order: 0 },
      { name: 'b', order: 2 },
    ]);
  });
});
