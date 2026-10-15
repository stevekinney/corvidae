/**
 * Splits text input (UTF-8 bytes) into frame-sized operations without splitting meaning.
 *
 * A chunk boundary falls only between atoms. An atom is one UTF-8 character or one complete
 * escape sequence (CSI, a string introduced by OSC, DCS, SOS, PM or APC, or a short escape), so the
 * bracketed-paste markers `ESC [ 200 ~` and `ESC [ 201 ~` are never cut, and neither is any
 * sequence a paste carries. Pieces are only ever joined back in order, so concatenating the chunks
 * returns the input exactly. An atom larger than the limit cannot be sent whole, so the plan fails
 * and nothing is sent: a partial sequence would change what the terminal does with the rest.
 */

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;

function characterLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  return 2;
}

/** The end (exclusive) of the escape sequence that starts at `start`, which holds ESC. */
function escapeEnd(bytes: Uint8Array, start: number): number {
  const length = bytes.length;
  const introducer = start + 1 < length ? bytes[start + 1]! : 0;
  // A lone ESC, or one followed by a control or a non-ASCII byte, introduces nothing.
  if (introducer < 0x20 || introducer > 0x7e) return start + 1;
  let index = start + 2;
  if (introducer === 0x5b) {
    // CSI: parameter and intermediate bytes (0x20 to 0x3f), then one final byte (0x40 to 0x7e).
    while (index < length && bytes[index]! >= 0x20 && bytes[index]! <= 0x3f) index += 1;
    return index < length && bytes[index]! >= 0x40 && bytes[index]! <= 0x7e ? index + 1 : index;
  }
  if (
    introducer === 0x5d ||
    introducer === 0x50 ||
    introducer === 0x58 ||
    introducer === 0x5e ||
    introducer === 0x5f
  ) {
    // A string (OSC, DCS, SOS, PM, APC) runs to BEL or to ST (ESC \).
    while (index < length) {
      if (bytes[index] === BEL) return index + 1;
      if (bytes[index] === ESC && bytes[index + 1] === BACKSLASH) return index + 2;
      index += 1;
    }
    return length;
  }
  // A short escape: intermediate bytes (0x20 to 0x2f), then one final byte.
  index = start + 1;
  while (index < length && bytes[index]! >= 0x20 && bytes[index]! <= 0x2f) index += 1;
  return index < length ? index + 1 : length;
}

function atomEnd(bytes: Uint8Array, start: number): number {
  const lead = bytes[start]!;
  return Math.min(
    bytes.length,
    lead === ESC ? escapeEnd(bytes, start) : start + characterLength(lead),
  );
}

/**
 * Plans the operations that carry `bytes`, each at most `limit` bytes. Returns `undefined` when
 * `limit` is not a positive integer or an atom is larger than `limit`. An empty input is one empty
 * operation, because the engine reported it and the wire decides what an empty payload means.
 */
export function planInputChunks(bytes: Uint8Array, limit: number): Uint8Array[] | undefined {
  if (!Number.isSafeInteger(limit) || limit < 1) return undefined;
  if (bytes.length === 0) return [bytes];
  const chunks: Uint8Array[] = [];
  let chunkStart = 0;
  let index = 0;
  while (index < bytes.length) {
    const end = atomEnd(bytes, index);
    if (end - index > limit) return undefined;
    if (end - chunkStart > limit) {
      chunks.push(bytes.slice(chunkStart, index));
      chunkStart = index;
    }
    index = end;
  }
  chunks.push(bytes.slice(chunkStart));
  return chunks;
}
