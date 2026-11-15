import { describe, expect, test } from 'bun:test';

import { hiddenRowCounts, wholeRowsBlockSize, type RowEdges } from './whole-rows.ts';

// Rows stand `gap` apart after `start` of padding; a ready row is 40px, a failed row with an error
// line is 62px.
function rows(heights: number[], start = 8, gap = 8): RowEdges[] {
  let top = start;
  return heights.map((height) => {
    const edge = { top, bottom: top + height };
    top += height + gap;
    return edge;
  });
}

describe('wholeRowsBlockSize', () => {
  test('returns undefined when every row fits, so nothing is capped', () => {
    expect(wholeRowsBlockSize(rows([40, 62]), 192)).toBeUndefined();
  });

  test('ends the window on the last row that fits, with no part of the next row showing', () => {
    // Bottoms 48, 118, 166, 214, 262: the third row is the last that fits in 192.
    const edges = rows([40, 62, 40, 40, 40]);
    const size = wholeRowsBlockSize(edges, 192)!;
    expect(size).toBe(166);
    expect(edges.filter((edge) => edge.top < size).map((edge) => edge.bottom)).toEqual([
      48, 118, 166,
    ]);
  });

  test('does not let a failed row straddle the end of the window', () => {
    // Bottoms 48, 118, 188, 236: the third row ends at 188, inside 192, so it is whole.
    expect(wholeRowsBlockSize(rows([40, 62, 62, 40]), 192)).toBe(188);
    // With 180 of room the third row would be cut, so the window ends on the second.
    expect(wholeRowsBlockSize(rows([40, 62, 62, 40]), 180)).toBe(118);
  });

  test('keeps the end inset past the last whole row and counts it against the room', () => {
    // Bottoms 48, 96, 144, 192, 240: with 8px of inset the fourth row (200) no longer fits in 192.
    expect(wholeRowsBlockSize(rows([40, 40, 40, 40, 40]), 192, 8)).toBe(144 + 8);
  });

  test('shows the first row whole when it alone is taller than the window', () => {
    expect(wholeRowsBlockSize(rows([300, 60]), 192)).toBe(308);
  });
});

describe('hiddenRowCounts', () => {
  test('a row mostly in view is not counted as hidden', () => {
    const edges = rows([40, 40, 40, 40], 0, 0); // tops 0, 40, 80, 120
    // Window 0..100: the third row is half-plus visible (20 of 40 hidden is not more than half).
    expect(hiddenRowCounts(edges, 0, 100)).toEqual({ above: 0, below: 1 });
    // Window 0..90: 30 of the third row hidden, more than half, so two rows are out of sight.
    expect(hiddenRowCounts(edges, 0, 90)).toEqual({ above: 0, below: 2 });
  });

  test('five rows in a two-row window: counts what is out of view at each end', () => {
    const edges = rows([56, 56, 56, 56, 56], 0, 0);
    const viewport = 112;
    expect(hiddenRowCounts(edges, 168, viewport)).toEqual({ above: 3, below: 0 });
    // A row cut in half is counted as showing, never "3 more".
    expect(hiddenRowCounts(edges, 140, viewport)).toEqual({ above: 2, below: 0 });
  });
});
