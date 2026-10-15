/**
 * A bounded plain-text projection of the active retained terminal buffer, for the accessible
 * snapshot, search, and export. It reads only the engine's public line metadata: a row continues
 * the previous one exactly when the engine marks it wrapped, so no second parser is involved and
 * nothing is guessed from column positions.
 *
 * When the retained output is larger than the bound, the projection keeps the newest content:
 * it reads back from the newest row and starts at a whole logical line, or, when the newest line
 * alone is larger than the bound, at a whole code point. Nothing is added to the text to say that
 * earlier output was omitted; `truncated` says it.
 *
 * It is private to the package. Nothing here is exported from the package entry.
 */

/** The accessible-snapshot budget from `documentation/terminal/security-and-budgets.md`: 64 KiB. */
export const DEFAULT_PROJECTION_BYTE_LIMIT = 64 * 1024;

/** The slice of an engine buffer row the projection reads. */
export type ProjectionLine = {
  readonly isWrapped: boolean;
  /** The row width in cells, which a hostile program can make as wide as 65,535. */
  readonly length: number;
  /**
   * The text of columns `startColumn` up to `endColumn`. Trailing cells that never held content
   * are trimmed against the whole row, not the slice, so a slice past the content is empty and a
   * written space is content.
   */
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
};

/** The slice of an engine buffer the projection reads. */
export type ProjectionBuffer = {
  readonly length: number;
  getLine(row: number): ProjectionLine | undefined;
};

export type TerminalProjection = {
  /** Soft-wrapped rows joined, hard line boundaries as LF, no trailing blank lines. */
  text: string;
  /**
   * Whether earlier retained content was left out because of the byte limit. Reading stops at the
   * limit, so the size of the content before it is never computed.
   */
  truncated: boolean;
  /** UTF-8 bytes in `text`. */
  bytes: number;
  /**
   * Where each whole logical line in `text` starts, oldest first: its first buffer row and the
   * UTF-16 offset of its first character. A newest line cut at a code point has no entry, because
   * its first row is not known.
   */
  lines: readonly ProjectedLine[];
};

export type ProjectedLine = { row: number; start: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The most cells read per call. */
const ROW_SLICE_CELLS = 256;

const byteLength = (text: string): number => encoder.encode(text).length;

/** The longest suffix of `text` that fits `maximumBytes`, starting at a whole code point. */
function tailWithinBytes(text: string, maximumBytes: number): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= maximumBytes) return text;
  let start = encoded.length - maximumBytes;
  // A UTF-8 continuation byte has the bit pattern 10xxxxxx; step forward to the next code point.
  while (start < encoded.length && (encoded[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  return decoder.decode(encoded.subarray(start));
}

/**
 * The cell just past a row's content, found without reading the row: a two-cell window is empty
 * exactly when it starts past the last content, so the first empty window marks the end.
 */
function contentEnd(line: ProjectionLine): number {
  let low = 0;
  let high = line.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (line.translateToString(true, middle, middle + 2) === '') high = middle;
    else low = middle + 1;
  }
  return Math.min(line.length, low + 1);
}

/**
 * The end of one row's text, read backwards until `budget` bytes are held or the row's first cell
 * is reached. A slice is never wider than the bytes still unspent: every cell that holds anything
 * contributes at least one byte, so a wider read could only fetch text that is about to be
 * discarded. A slice is also clipped to its last `unspent` code units before it is encoded, because
 * a code unit encodes to at least one byte, so only those can matter. `complete` is false when
 * cells before the text were left unread.
 */
function readRowTail(
  line: ProjectionLine,
  budget: number,
): { text: string; bytes: number; complete: boolean } {
  const slices: string[] = [];
  let bytes = 0;
  let column = line.length;
  let clipped = false;
  let probed = false;
  while (column > 0 && bytes < budget) {
    const unspent = budget - bytes;
    const start = Math.max(0, column - Math.min(ROW_SLICE_CELLS, unspent));
    let slice = line.translateToString(true, start, column);
    if (slice === '' && bytes === 0) {
      // A blank tail. A wide row jumps straight to where its content ends instead of stepping
      // across the blank cells.
      if (!probed && line.length > ROW_SLICE_CELLS) {
        probed = true;
        column = contentEnd(line);
      } else {
        column = start;
      }
      continue;
    }
    if (slice.length > unspent) {
      slice = slice.slice(slice.length - unspent);
      // Clipping can land between the halves of a surrogate pair; the stray half goes.
      const first = slice.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) slice = slice.slice(1);
      clipped = true;
    }
    slices.push(slice);
    bytes += byteLength(slice);
    column = start;
  }
  return { text: slices.reverse().join(''), bytes, complete: column === 0 && !clipped };
}

/**
 * Project `buffer` to at most `maximumBytes` UTF-8 bytes, keeping the newest content. Rows are read
 * from the newest backwards, one bounded slice at a time, and reading stops the moment a line
 * cannot fit, so the work and the allocation are bounded by the limit rather than by the retained
 * scrollback or by how wide a row is. Wide characters contribute their character once: the engine
 * reports their continuation cell as empty, so no padding space appears between or after them.
 */
export function projectBuffer(
  buffer: ProjectionBuffer,
  maximumBytes: number = DEFAULT_PROJECTION_BYTE_LIMIT,
): TerminalProjection {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError(`maximumBytes must be a positive whole number, received ${maximumBytes}`);
  }
  /** Lines kept, newest first. `row` is -1 for a newest line cut at a code point. */
  const kept: Array<{ row: number; text: string }> = [];
  let total = 0;
  let truncated = false;
  // Blank lines at the end of the buffer are not content, and cost one read each.
  let trailing = true;
  // The logical line being read, its rows' text newest row first.
  let pieces: string[] = [];
  let groupBytes = 0;
  let overflowed = false;

  /** A line is complete: keep it, or drop it when it is a blank tail. */
  function completeGroup(row: number): void {
    const text = pieces.toReversed().join('');
    pieces = [];
    const bytes = groupBytes;
    groupBytes = 0;
    if (text === '' && trailing) return;
    trailing = false;
    total += bytes + (kept.length > 0 ? 1 : 0);
    kept.push({ row, text });
  }

  for (let row = buffer.length - 1; row >= 0 && !overflowed; row -= 1) {
    const line = buffer.getLine(row);
    if (line === undefined) continue;
    const remaining = maximumBytes - total - (kept.length > 0 ? 1 : 0);
    const piece = readRowTail(line, Math.max(1, remaining - groupBytes));
    pieces.push(piece.text);
    groupBytes += piece.bytes;
    if (!piece.complete || groupBytes > remaining) {
      // This line cannot fit whole. With nothing newer kept, its end is all there is room for.
      if (kept.length === 0) {
        const tail = tailWithinBytes(pieces.toReversed().join(''), maximumBytes);
        pieces = [];
        groupBytes = 0;
        kept.push({ row: -1, text: tail });
        total = byteLength(tail);
      }
      truncated = true;
      overflowed = true;
    } else if (!line.isWrapped || row === 0) {
      completeGroup(row);
    }
  }
  if (pieces.length > 0 && !overflowed) completeGroup(0);

  const ordered = kept.toReversed();
  const lines: ProjectedLine[] = [];
  let offset = 0;
  for (const entry of ordered) {
    if (entry.row >= 0) lines.push({ row: entry.row, start: offset });
    offset += entry.text.length + 1;
  }
  return { text: ordered.map((entry) => entry.text).join('\n'), truncated, bytes: total, lines };
}
