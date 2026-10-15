/**
 * The engine reports input in two distinct shapes, and each has its own byte conversion.
 *
 * - Text (`onData`): a JavaScript string of characters. It goes out as UTF-8.
 * - Binary (`onBinary`): a "binary string" in which each UTF-16 unit is one byte, 0 to 255. It
 *   goes out as exactly those bytes. Mouse reports past column 95 are the case that needs it: the
 *   X10 encoding writes a coordinate as a single byte, and UTF-8 would turn byte 0x80 into two.
 *
 * Neither conversion rewrites its input. A report that cannot be converted exactly is refused by
 * returning `undefined`, never repaired with a replacement character or a truncated code unit.
 */

const encoder = new TextEncoder();

/** UTF-8 bytes of `data`, or `undefined` when it holds a lone surrogate that has no UTF-8 form. */
export function encodeTextReport(data: string): Uint8Array | undefined {
  return data.isWellFormed() ? encoder.encode(data) : undefined;
}

/** One byte per UTF-16 unit, or `undefined` when a unit is above 255 and so is not a byte. */
export function encodeBinaryReport(data: string): Uint8Array | undefined {
  const bytes = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    const unit = data.charCodeAt(index);
    if (unit > 0xff) return undefined;
    bytes[index] = unit;
  }
  return bytes;
}
