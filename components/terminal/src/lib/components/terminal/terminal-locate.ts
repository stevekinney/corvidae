import type { ProjectionLine, TerminalProjection } from './terminal-projection.ts';

/**
 * Maps a range of the projection's text back to the buffer cells it came from, so the engine can
 * select exactly the text a search found. It reads only public line and cell metadata and never
 * guesses: a range it cannot place exactly is reported as unplaceable, and nothing is selected.
 */

/** The slice of an engine cell the mapping reads. */
export type LocateCell = { getChars(): string; getWidth(): number };

export type LocateLine = ProjectionLine & { getCell(column: number): LocateCell | undefined };

export type LocateBuffer = {
  readonly length: number;
  getLine(row: number): LocateLine | undefined;
};

/** A selection in the engine's terms: a start cell and a length in cells along the buffer. */
export type CellSelection = { column: number; row: number; length: number };

type Position = { row: number; column: number };

/** The UTF-16 units a cell adds to the text: none for a continuation, one for an unwritten gap. */
function unitsOf(cell: LocateCell): number {
  if (cell.getWidth() === 0) return 0;
  const chars = cell.getChars();
  return chars === '' ? 1 : chars.length;
}

/**
 * The column in `line` just before the character `remaining` units into its text, or just after
 * its last one when `atEnd` and `remaining` is the whole text. Undefined when that point falls
 * inside one cell's characters, such as between a base character and its combining mark.
 */
function columnWithin(
  line: LocateLine,
  remaining: number,
  textLength: number,
  atEnd: boolean,
): number | undefined {
  if (remaining === 0 && (textLength > 0 || atEnd)) return 0;
  let accumulated = 0;
  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column);
    if (cell === undefined) return undefined;
    if (cell.getWidth() !== 0 && accumulated === remaining && remaining < textLength) return column;
    accumulated += unitsOf(cell);
    if (atEnd && accumulated >= textLength) {
      let end = column + 1;
      while (end < line.length && line.getCell(end)?.getWidth() === 0) end += 1;
      return accumulated === textLength ? end : undefined;
    }
  }
  return undefined;
}

function positionOf(
  buffer: LocateBuffer,
  projection: TerminalProjection,
  offset: number,
): Position | undefined {
  const { lines, text } = projection;
  let index = -1;
  for (let candidate = 0; candidate < lines.length; candidate += 1) {
    if (lines[candidate]!.start > offset) break;
    index = candidate;
  }
  if (index < 0) return undefined;
  const entry = lines[index]!;
  const lineEnd = index + 1 < lines.length ? lines[index + 1]!.start - 1 : text.length;
  if (offset > lineEnd) return undefined;
  let remaining = offset - entry.start;
  for (let row = entry.row; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (line === undefined || (row > entry.row && !line.isWrapped)) return undefined;
    const length = line.translateToString(true).length;
    const next = buffer.getLine(row + 1);
    const last = next === undefined || !next.isWrapped;
    if (remaining < length || (remaining === length && last)) {
      const column = columnWithin(line, remaining, length, last && remaining === length);
      return column === undefined ? undefined : { row, column };
    }
    remaining -= length;
  }
  return undefined;
}

/**
 * The cells holding `text[start, end)`, as a selection `columns` wide, or `undefined` when either
 * end cannot be placed. A range that continues across a soft wrap is one run of cells; a range
 * that crosses a hard line break covers the cells between the rows too.
 */
export function locateRange(
  buffer: LocateBuffer,
  projection: TerminalProjection,
  columns: number,
  range: { start: number; end: number },
): CellSelection | undefined {
  const from = positionOf(buffer, projection, range.start);
  const to = positionOf(buffer, projection, range.end);
  if (from === undefined || to === undefined) return undefined;
  const length = (to.row - from.row) * columns + (to.column - from.column);
  return length > 0 ? { column: from.column, row: from.row, length } : undefined;
}
