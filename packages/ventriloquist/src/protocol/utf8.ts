const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function isLowSurrogate(unit: number): boolean {
  return unit >= LOW_SURROGATE_START && unit <= LOW_SURROGATE_END;
}

/**
 * The code point that starts at `index`, and how many UTF-16 units it spans. A lone surrogate is
 * replaced with U+FFFD, which is what the platform encoder does, so the output is always valid UTF-8.
 */
function codePointAt(text: string, index: number): { codePoint: number; units: 1 | 2 } {
  const unit = text.charCodeAt(index);
  if (unit >= HIGH_SURROGATE_START && unit <= HIGH_SURROGATE_END) {
    const next = text.charCodeAt(index + 1);
    if (isLowSurrogate(next)) {
      return {
        codePoint: 0x10000 + ((unit - HIGH_SURROGATE_START) << 10) + (next - LOW_SURROGATE_START),
        units: 2,
      };
    }
    return { codePoint: 0xfffd, units: 1 };
  }
  if (isLowSurrogate(unit)) {
    return { codePoint: 0xfffd, units: 1 };
  }
  return { codePoint: unit, units: 1 };
}

function encodedLength(codePoint: number): 1 | 2 | 3 | 4 {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * The number of bytes `text` occupies as UTF-8. This, never `text.length`, is what a transport
 * counts: `length` is a UTF-16 code unit count and differs for every non-ASCII character.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const { codePoint, units } = codePointAt(text, index);
    bytes += encodedLength(codePoint);
    index += units;
  }
  return bytes;
}

/**
 * Encode `text` as UTF-8. The string convenience API of the protocol means UTF-8 only. It is
 * written out here because the platform-neutral program has no `TextEncoder` to call.
 */
export function encodeUtf8(text: string): Uint8Array {
  const bytes = new Uint8Array(utf8ByteLength(text));
  let offset = 0;
  for (let index = 0; index < text.length;) {
    const { codePoint, units } = codePointAt(text, index);
    index += units;
    switch (encodedLength(codePoint)) {
      case 1:
        bytes[offset++] = codePoint;
        break;
      case 2:
        bytes[offset++] = 0xc0 | (codePoint >> 6);
        bytes[offset++] = 0x80 | (codePoint & 0x3f);
        break;
      case 3:
        bytes[offset++] = 0xe0 | (codePoint >> 12);
        bytes[offset++] = 0x80 | ((codePoint >> 6) & 0x3f);
        bytes[offset++] = 0x80 | (codePoint & 0x3f);
        break;
      case 4:
        bytes[offset++] = 0xf0 | (codePoint >> 18);
        bytes[offset++] = 0x80 | ((codePoint >> 12) & 0x3f);
        bytes[offset++] = 0x80 | ((codePoint >> 6) & 0x3f);
        bytes[offset++] = 0x80 | (codePoint & 0x3f);
        break;
    }
  }
  return bytes;
}
