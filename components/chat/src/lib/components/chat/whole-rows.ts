/**
 * Whole-row arithmetic for the opened attachment shelf, a capped list that scrolls: its window
 * ends on a whole row and the rows out of sight are counted for its "N more" line. (The question
 * dock shows every choice and lets its last visible row be cut by the edge, so it does not use
 * this.)
 */

/** One row's edges, measured from the list's top edge with the scroll offset included. */
export type RowEdges = { top: number; bottom: number };

/**
 * The block size that ends the window on a whole row, or `undefined` when every row already fits
 * and there is nothing to cap. `endInset` is the room the list keeps after its last visible row
 * (the end padding that holds a hit-area overhang); the window is that room past the last row that
 * fits, so no part of the next row shows. A first row taller than the window is still shown whole.
 */
export function wholeRowsBlockSize(
  edges: readonly RowEdges[],
  room: number,
  endInset = 0,
): number | undefined {
  const last = edges.at(-1);
  if (last === undefined || last.bottom + endInset <= room + 1) return undefined;
  const whole = edges.filter((edge) => edge.bottom + endInset <= room + 1).at(-1) ?? edges[0]!;
  return whole.bottom + endInset;
}

/**
 * How many rows are out of sight at each edge. A row counts as hidden only when more than half of
 * it is out of view, so a row mostly showing is not reported as "more".
 */
export function hiddenRowCounts(
  edges: readonly RowEdges[],
  scrollTop: number,
  viewport: number,
): { above: number; below: number } {
  let above = 0;
  let below = 0;
  for (const { top, bottom } of edges) {
    const half = (bottom - top) / 2;
    if (scrollTop - top > half) above += 1;
    else if (bottom - (scrollTop + viewport) > half) below += 1;
  }
  return { above, below };
}
