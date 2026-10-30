/** One entry of an object or array, ready for the Fields view. */
export type PayloadEntry = {
  /** The property name, or the 1-based position for an array entry. */
  key: string;
  /** The value. A `Date` is already written as its ISO string, or `Invalid Date` when it holds no time. */
  value: unknown;
  /** True when the value is an object or array, which the Fields view nests. */
  nested: boolean;
  /** True when `key` is a position in an array, not a property name to format. */
  isIndex: boolean;
};

function isNested(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !(value instanceof Date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isNested(value) && !Array.isArray(value);
}

/** A `Date` as its ISO string. An invalid one has none, and `toISOString` would throw. */
function writeDate(value: Date): string {
  return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
}

function toEntry(key: string, value: unknown, isIndex: boolean): PayloadEntry {
  const written = value instanceof Date ? writeDate(value) : value;
  return { key, value: written, nested: isNested(written), isIndex };
}

/**
 * Lists the entries of an object or array, in order. Anything else has none.
 * Array entries are keyed by their 1-based position.
 */
export function readPayloadEntries(source: unknown): PayloadEntry[] {
  if (Array.isArray(source)) {
    return source.map((value, index) => toEntry(String(index + 1), value, true));
  }
  if (isRecord(source)) {
    return Object.entries(source).map(([key, value]) => toEntry(key, value, false));
  }
  return [];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEXADECIMAL = /^[0-9a-f]{24,}$/i;
const IDENTIFIER_KEY =
  /(?:^|[_\-\s.])(?:ids?|uuids?|hash|digest|sha\d*|checksum)$|[a-z0-9](?:Ids?|Uuids?|Hash)$/;

/**
 * True when a text value is an identifier or a hash, which the Fields view sets
 * in small monospace: a UUID, a long hexadecimal digest, or any text under a key
 * that ends in `id`, `uuid`, `hash`, `digest` or `checksum`.
 */
export function isIdentifierField(key: string, value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  return UUID.test(value) || LONG_HEXADECIMAL.test(value) || IDENTIFIER_KEY.test(key);
}
