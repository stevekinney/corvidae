/**
 * The column a cell starts in: the sum of the spans of the cells before it in its row. A header
 * cell and the body cells under it agree on this, so it carries a column's `sizing` from one to the
 * other. `cellIndex` counts cells, not columns, so a `colspan` before a cell would misplace it.
 */
export function columnOf(cell: Element): number {
  let column = 0;
  for (
    let sibling = cell.previousElementSibling;
    sibling;
    sibling = sibling.previousElementSibling
  ) {
    if (sibling instanceof HTMLTableCellElement) column += Math.max(1, sibling.colSpan);
  }
  return column;
}

/** A cell's `colspan` prop as a whole number of columns, at least one. */
export function spanOf(colspan: unknown): number {
  const span = Number(colspan ?? 1);
  return Number.isInteger(span) && span > 1 ? span : 1;
}
