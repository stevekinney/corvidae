/**
 * The selected engine decodes UTF-8 itself and, in `@xterm/xterm` 6.0.0, drops U+200B and U+200D
 * when a write ends after the second byte of their three-byte encoding (`E2 80`) and the next
 * write supplies the third. Output chunks can end anywhere, so the renderer never hands the engine
 * a write that ends inside a UTF-8 sequence: it holds the unfinished tail and prepends it to the
 * next chunk. At most three bytes are ever held.
 */

/** How many bytes a sequence starting with `lead` needs, or 1 for a byte that is not a lead. */
function sequenceLength(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 1;
}

/**
 * Whether `second`, the byte after `lead`, can continue a well-formed sequence. The lead-specific
 * ranges reject overlong forms (E0, F0), surrogates (ED), and code points past U+10FFFF (F4);
 * every other lead accepts any continuation byte.
 */
function continues(lead: number, second: number): boolean {
  if (lead === 0xe0) return second >= 0xa0 && second <= 0xbf;
  if (lead === 0xed) return second >= 0x80 && second <= 0x9f;
  if (lead === 0xf0) return second >= 0x90 && second <= 0xbf;
  if (lead === 0xf4) return second >= 0x80 && second <= 0x8f;
  return true;
}

/**
 * The number of trailing bytes of `bytes` that begin a UTF-8 sequence it does not finish: 0 when
 * the bytes end on a character boundary, or when the end is not a valid sequence prefix at all
 * (invalid bytes pass through to the engine, which treats them as data).
 */
export function incompleteUtf8Tail(bytes: Uint8Array): number {
  const limit = Math.min(3, bytes.length);
  for (let back = 1; back <= limit; back += 1) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0b1100_0000) === 0b1000_0000) continue;
    if (sequenceLength(byte) <= back) return 0;
    // A prefix the engine would reject whatever follows is data now, not something to wait on.
    if (back > 1 && !continues(byte, bytes[bytes.length - back + 1]!)) return 0;
    return back;
  }
  return 0;
}

export type Utf8Carry = {
  /**
   * The bytes to write for `chunk`: whatever was held back, then `chunk`, minus any new unfinished
   * tail, which is held for the next call. The result may be empty.
   */
  take(chunk: Uint8Array): Uint8Array;
  /** How many bytes are held for the next call. */
  readonly pending: number;
  /** Give up whatever is held, because no further output will finish it. */
  flush(): Uint8Array;
};

export function createUtf8Carry(): Utf8Carry {
  let held: Uint8Array = new Uint8Array(0);
  return {
    take(chunk) {
      const joined = new Uint8Array(held.length + chunk.length);
      joined.set(held);
      joined.set(chunk, held.length);
      const tail = incompleteUtf8Tail(joined);
      held = joined.slice(joined.length - tail);
      return joined.subarray(0, joined.length - tail);
    },
    get pending() {
      return held.length;
    },
    flush() {
      const rest = held;
      held = new Uint8Array(0);
      return rest;
    },
  };
}
