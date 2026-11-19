/**
 * The one rule Home and Health share for what a summary shows (owner, 2026-11-19): a count is a
 * tile only when it says something, and nothing is a card that says nothing. A count of zero is no
 * tile, so a page where every count is zero shows no tile row at all; a count that has not answered
 * yet is no tile either (a later zero would only take it away again). A count that could not be read
 * (`null`) stays, because "this could not be read" is something to know.
 */

/** A count as a summary holds it: a number, `null` when it could not be read, `undefined` while it is read. */
export interface SummaryCount {
  readonly value: number | null | undefined;
}

/** Whether a count is worth a tile: it is above zero, or it could not be read. */
export function countIsWorthShowing(count: SummaryCount): boolean {
  return count.value === null || (count.value !== undefined && count.value > 0);
}

/** The counts worth a tile, in the order given. An empty list means no tile row at all. */
export function countsWorthShowing<T extends SummaryCount>(counts: readonly T[]): T[] {
  return counts.filter((count) => countIsWorthShowing(count));
}

/**
 * Whether a list of what needs a person is clear: it has answered and holds nothing. A clear list
 * draws no card, only the one quiet line (`QuietLine`), or nothing, and gives its space to what has
 * content.
 */
export function listIsClear(rows: readonly unknown[] | undefined): boolean {
  return rows !== undefined && rows.length === 0;
}
