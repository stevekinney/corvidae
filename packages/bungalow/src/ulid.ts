const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIMESTAMP_LENGTH = 10;
const RANDOM_LENGTH = 16;
const MAXIMUM_TIMESTAMP = 2 ** 48 - 1;

/** The shape of a ULID: 26 Crockford base32 characters whose timestamp fits in 48 bits. */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

function encodeTimestamp(timestamp: number): string {
  let remaining = timestamp;
  let encoded = '';
  for (let index = 0; index < TIMESTAMP_LENGTH; index += 1) {
    encoded = CROCKFORD.charAt(remaining % 32) + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

/** Sixteen characters from ten bytes, five bits at a time, with no randomness discarded. */
function encodeRandom(bytes: Uint8Array): string {
  let encoded = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += CROCKFORD.charAt((accumulator >> bits) & 31);
    }
    accumulator &= (1 << bits) - 1;
  }
  return encoded;
}

/**
 * A ULID: a 48-bit millisecond timestamp then 80 random bits, in Crockford base32, so identifiers
 * sort by creation time. Both inputs are injectable for tests.
 */
export function generateUlid(
  timestamp: number = Date.now(),
  fillRandom: (bytes: Uint8Array) => void = (bytes) => {
    crypto.getRandomValues(bytes);
  },
): string {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > MAXIMUM_TIMESTAMP) {
    throw new RangeError('A ULID timestamp must be an integer between 0 and 2^48 - 1.');
  }
  const bytes = new Uint8Array((RANDOM_LENGTH * 5) / 8);
  fillRandom(bytes);
  return encodeTimestamp(timestamp) + encodeRandom(bytes);
}
