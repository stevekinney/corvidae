/**
 * Whole-row arithmetic for the lists that are capped and scroll: the opened attachment shelf and
 * the question dock's choices. Both size their window to end on a whole row, snap their scroll to a
 * row boundary, and count the rows out of sight for their "N more" lines, so the two lists cannot
 * disagree about what a row is, what is hidden, or where the window ends.
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
 * The scroll offset that puts a row's top at the window's start edge: the row nearest the current
 * offset, so the window never rests on a half row. The offset is left alone at the end of the
 * scroll range, where the last row sits against the end edge.
 */
export function snapScrollTop(
  edges: readonly RowEdges[],
  scrollTop: number,
  maxScrollTop: number,
): number {
  if (scrollTop >= maxScrollTop - 1) return scrollTop;
  let snapped = scrollTop;
  let distance = Number.POSITIVE_INFINITY;
  for (const edge of edges) {
    const gap = Math.abs(edge.top - scrollTop);
    if (gap < distance) {
      distance = gap;
      snapped = edge.top;
    }
  }
  return Math.min(snapped, maxScrollTop);
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
