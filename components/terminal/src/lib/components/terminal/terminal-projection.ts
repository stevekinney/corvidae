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
  /** Trailing cells that never held content are trimmed; a written space is content. */
  translateToString(trimRight?: boolean): string;
};

/** The slice of an engine buffer the projection reads. */
export type ProjectionBuffer = {
  readonly length: number;
  getLine(row: number): ProjectionLine | undefined;
};

export type TerminalProjection = {
  /** Soft-wrapped rows joined, hard line boundaries as LF, no trailing blank lines. */
  text: string;
  /** Whether `text` stops short of the retained content because of the byte limit. */
  truncated: boolean;
  /** UTF-8 bytes in `text`. */
  bytes: number;
  /** UTF-8 bytes the whole retained content would need. */
  retainedBytes: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function logicalLines(buffer: ProjectionBuffer): string[] {
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (line === undefined) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Project `buffer` to at most `maximumBytes` UTF-8 bytes, cutting at the last whole code point
 * that fits. Wide characters contribute their character once: the engine reports their
 * continuation cell as empty, so no padding space appears between or after them.
 */
export function projectBuffer(
  buffer: ProjectionBuffer,
  maximumBytes: number = DEFAULT_PROJECTION_BYTE_LIMIT,
): TerminalProjection {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError(`maximumBytes must be a positive whole number, received ${maximumBytes}`);
  }
  const encoded = encoder.encode(logicalLines(buffer).join('\n'));
  if (encoded.length <= maximumBytes) {
    return {
      text: decoder.decode(encoded),
      truncated: false,
      bytes: encoded.length,
      retainedBytes: encoded.length,
    };
  }
  let cut = maximumBytes;
  // A UTF-8 continuation byte has the bit pattern 10xxxxxx; step back to the start of its code point.
  while (cut > 0 && (encoded[cut]! & 0b1100_0000) === 0b1000_0000) cut -= 1;
  return {
    text: decoder.decode(encoded.subarray(0, cut)),
    truncated: true,
    bytes: cut,
    retainedBytes: encoded.length,
  };
}
