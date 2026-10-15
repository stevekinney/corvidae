/**
 * A bounded plain-text projection of the active retained terminal buffer, for the accessible
 * snapshot, search, and export that later issues add. It reads only the engine's public line
 * metadata: a row continues the previous one exactly when the engine marks it wrapped, so no
 * second parser is involved and nothing is guessed from column positions.
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
   * Whether `text` stops short of the retained content because of the byte limit. Reading stops
   * at the limit, so the size of the content beyond it is never computed.
   */
  truncated: boolean;
  /** UTF-8 bytes in `text`. */
  bytes: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The most cells read per call. A slice is also never wider than the bytes still unspent: every
 * cell that holds anything contributes at least one byte, so a wider read could only fetch text
 * that the limit is about to discard.
 */
const ROW_SLICE_CELLS = 256;

/**
 * Project `buffer` to at most `maximumBytes` UTF-8 bytes, cutting at the last whole code point
 * that fits. Rows are read one bounded slice at a time and reading stops the moment the limit is
 * reached, so the work and the allocation are bounded by the limit rather than by the retained
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
  const parts: string[] = [];
  let bytes = 0;

  /**
   * Adds `text`, or the longest whole-code-point prefix of it that fits. False once full. Text is
   * clipped to the unspent bytes before it is encoded: a UTF-16 code unit encodes to at least one
   * byte, so a longer text cannot fit and only its first `unspent` units can matter.
   */
  function append(text: string): boolean {
    const unspent = maximumBytes - bytes;
    const overflows = text.length > unspent;
    const segment = encoder.encode(overflows ? text.slice(0, unspent) : text);
    if (!overflows && segment.length <= unspent) {
      parts.push(text);
      bytes += segment.length;
      return true;
    }
    let cut = Math.min(unspent, segment.length);
    // A UTF-8 continuation byte has the bit pattern 10xxxxxx; step back to the start of its code point.
    while (cut > 0 && (segment[cut]! & 0b1100_0000) === 0b1000_0000) cut -= 1;
    parts.push(decoder.decode(segment.subarray(0, cut)));
    bytes += cut;
    return false;
  }

  // Line breaks wait until content follows them, which drops the blank tail without reading it.
  let pendingBreaks = 0;
  let started = false;
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (line === undefined) continue;
    if (!(line.isWrapped && started)) {
      if (started) pendingBreaks += 1;
      started = true;
    }
    // A slice is empty exactly when it starts past the row's last content, so the first empty
    // slice ends the row: a blank row costs one read, and a hostile one costs the limit.
    for (let column = 0; column < line.length;) {
      const width = Math.min(ROW_SLICE_CELLS, Math.max(1, maximumBytes - bytes));
      const text = line.translateToString(true, column, column + width);
      column += width;
      if (text === '') break;
      const lead = '\n'.repeat(pendingBreaks);
      pendingBreaks = 0;
      if (!append(lead + text)) return { text: parts.join(''), truncated: true, bytes };
    }
  }
  return { text: parts.join(''), truncated: false, bytes };
}
