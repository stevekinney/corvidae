import { formatBytes } from '../../utilities/format-bytes.ts';
import { formatDate, formatTimeOfDay } from '../../utilities/format-date.ts';
import { formatNumber } from '../../utilities/format-number.ts';
import { SecretValue } from './payload-inspector-secrets.ts';
import type { PayloadInspectorField } from './payload-inspector.types.ts';

/** How the Fields view lays out the pairs of one object. */
export type FieldsLayout = 'inline' | 'grid' | 'rows';

/** How an array reads in the Fields view. */
export type ArrayShape = 'empty' | 'scalars' | 'uniform' | 'mixed';

/** A value the Fields view writes as text on one line, or the stand-in for a hidden one. */
export type ScalarValue = string | number | boolean | bigint | null | SecretValue;

/** One `key: value` pair, as the layout rules read it. */
export type PairSummary = {
  /** The stored property name. */
  key: string;
  /** The value. */
  value: unknown;
  /** True when a link leads from this value. */
  linked: boolean;
};

// Frame 3 of the PayloadRenderer board: a few short pairs read as one line, "Order ID 4471, Amount
// $42.00". Frames 12, 13, 16 and 17 hold three or more pairs and stay rows, because a value there is
// masked, still arriving, a link or too long for one line.
const INLINE_MAXIMUM_PAIRS = 3;
const INLINE_MAXIMUM_VALUE_LENGTH = 36;
const INLINE_MAXIMUM_KEY_LENGTH = 24;
// Frame 4: eight pairs wrap into a grid sized to its content. Frame 12 holds five and stays rows.
const GRID_MINIMUM_PAIRS = 6;
const GRID_MAXIMUM_VALUE_LENGTH = 48;
/** A key longer than this truncates to one line, so it carries a tooltip with the whole key. */
export const LONG_KEY_LENGTH = 24;
/** Text longer than this, or text over more than one line, clamps to two lines with Show all. */
export const LONG_TEXT_LENGTH = 120;
/** An array of this many items or fewer is shown in full in the JSON view. */
export const LARGE_ARRAY_ABOVE = 50;
/** Rows a table shows before its footer offers to load more. */
export const TABLE_ROW_LIMIT = 8;

/** True for a value that fits on one line of text: a string, number, boolean, bigint, null, a Date or a hidden secret. */
export function isScalar(value: unknown): value is ScalarValue | Date {
  return (
    value === null ||
    typeof value !== 'object' ||
    value instanceof Date ||
    value instanceof SecretValue
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isScalar(value);
}

function lengthOf(value: unknown): number {
  if (value instanceof SecretValue) return 0;
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return value.length;
  if (value instanceof Date) return 24;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value).length;
  }
  return 0;
}

/** True when text should clamp to two lines with a Show all action. */
export function isLongText(value: unknown): value is string {
  return typeof value === 'string' && (value.length > LONG_TEXT_LENGTH || value.includes('\n'));
}

/**
 * Chooses how one object's pairs read. `inline` is one line of a few short scalar pairs, `grid` is
 * a wrapping key and value grid for many short pairs, and `rows` is one pair per row, which is
 * what everything else (long text, links, nested values, masked values) needs.
 */
export function chooseFieldsLayout(
  pairs: readonly PairSummary[],
  options: { streaming?: boolean } = {},
): FieldsLayout {
  if (options.streaming === true || pairs.length === 0) return 'rows';
  const allShort = pairs.every(
    (pair) =>
      isScalar(pair.value) &&
      !(pair.value instanceof SecretValue) &&
      !pair.linked &&
      !isLongText(pair.value),
  );
  if (!allShort) return 'rows';
  const keysShort = pairs.every((pair) => pair.key.length <= INLINE_MAXIMUM_KEY_LENGTH);
  if (
    pairs.length <= INLINE_MAXIMUM_PAIRS &&
    keysShort &&
    pairs.every((pair) => lengthOf(pair.value) <= INLINE_MAXIMUM_VALUE_LENGTH)
  ) {
    return 'inline';
  }
  if (
    pairs.length >= GRID_MINIMUM_PAIRS &&
    keysShort &&
    pairs.every((pair) => lengthOf(pair.value) <= GRID_MAXIMUM_VALUE_LENGTH)
  ) {
    return 'grid';
  }
  return 'rows';
}

function sortedKeys(record: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(record).toSorted());
}

/**
 * Sorts an array into the shape the Fields view draws: `scalars` (a bulleted list), `uniform`
 * (every item an object with the same keys and only scalar values, so a table with real headers),
 * or `mixed` (each item its own block of fields). Only a uniform array becomes a table.
 */
export function classifyArray(items: readonly unknown[]): ArrayShape {
  if (items.length === 0) return 'empty';
  if (items.every(isScalar)) return 'scalars';
  const records = items.filter(isPlainRecord);
  if (records.length !== items.length) return 'mixed';
  const first = records[0];
  if (first === undefined || Object.keys(first).length === 0) return 'mixed';
  const signature = sortedKeys(first);
  const uniform = records.every(
    (record) => sortedKeys(record) === signature && Object.values(record).every(isScalar),
  );
  return uniform ? 'uniform' : 'mixed';
}

/** The pluralized count of a nested value, "2 fields", "1 item", "2,140 items". */
export function countWords(count: number, noun: 'field' | 'item' | 'value'): string {
  return `${formatNumber(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** The count of what a value holds: its fields for an object, its items for an array. */
export function describeContents(value: unknown): string {
  if (Array.isArray(value)) return countWords(value.length, 'item');
  if (isPlainRecord(value)) return countWords(Object.keys(value).length, 'field');
  return countWords(1, 'value');
}

/** Options for {@link headerCount}. */
export type HeaderCountOptions = {
  /** True while the payload is still arriving, so the count reads "so far". */
  streaming?: boolean;
  /** The serialized size in bytes. It follows the count only above 1 KB. */
  bytes?: number | undefined;
};

/**
 * The header's count, in words: "1 field", "3 fields", "1 value" for a payload that is not an
 * object, "2 fields so far" while it arrives. The size follows after a comma only when the
 * payload is above 1 KB ("2 fields, 1.4 KB").
 */
export function headerCount(value: unknown, options: HeaderCountOptions = {}): string {
  const count = describeContents(value);
  const counted = options.streaming === true ? `${count} so far` : count;
  return options.bytes !== undefined && options.bytes > 1024
    ? `${counted}, ${formatBytes(options.bytes)}`
    : counted;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Writes an ISO date ("2026-10-24") as "Oct 24, 2026" and an ISO date and time with its zone as
 * "Oct 24, 2026, 10:00 AM" in the viewer's zone. Returns `undefined` for anything else, including a
 * date that does not exist, so a string is never reinterpreted on a guess.
 */
export function formatIsoDate(text: string): string | undefined {
  if (DATE_ONLY.test(text)) {
    const date = new Date(`${text}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return undefined;
    return formatDate(date, 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }
  if (DATE_TIME.test(text)) {
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return undefined;
    const day = formatDate(date, 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    return `${day}, ${formatTimeOfDay(date)}`;
  }
  return undefined;
}

/** What one scalar reads as, and how the Fields view should set it. */
export type ScalarDisplay =
  | { kind: 'secret' }
  | { kind: 'none' }
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'number'; text: string };

/**
 * Works out how the Fields view writes one scalar. It formats only what the JSON says
 * unambiguously: null reads "None", an empty string "Empty", booleans "Yes" and "No", an ISO date as
 * a date. A number reads as stored. Anything else comes from `override`, the caller's
 * `formatValue`, which wins whenever it returns text.
 */
export function describeScalar(value: unknown, override?: string): ScalarDisplay {
  if (value instanceof SecretValue) return { kind: 'secret' };
  if (override !== undefined) return { kind: 'text', text: override };
  if (value === null || value === undefined) return { kind: 'none' };
  if (value === '') return { kind: 'empty' };
  if (typeof value === 'boolean') return { kind: 'text', text: value ? 'Yes' : 'No' };
  if (typeof value === 'number' || typeof value === 'bigint') {
    return { kind: 'number', text: String(value) };
  }
  if (typeof value === 'string') {
    return { kind: 'text', text: formatIsoDate(value) ?? value };
  }
  return { kind: 'text', text: JSON.stringify(value) ?? '' };
}

/** True when a table column holds only single tokens ("text", "SKU-1000"), which read as code. */
export function isTokenColumn(values: readonly unknown[]): boolean {
  return (
    values.length > 0 &&
    values.every((value) => typeof value === 'string' && /^[\w.:/-]{1,32}$/.test(value))
  );
}

/** True when a table column holds only numbers, which align to the end. */
export function isNumberColumn(values: readonly unknown[]): boolean {
  return values.length > 0 && values.every((value) => typeof value === 'number');
}

/** The tooltip of a key too long for its column: the whole key and how long it is. */
export function describeLongKey(key: string): string {
  const shown = key.length > 240 ? `${key.slice(0, 240)}…` : key;
  return `${shown} (${formatNumber(key.length)} characters)`;
}

/** Text written at the end of a payload still arriving: the entries that are whole, and the key whose value is not. */
export type PartialObject = {
  /** Entries whose value has fully arrived. */
  entries: [string, unknown][];
  /** The key whose value has begun or is about to, when there is one. */
  pendingKey?: string;
  /** The text of that value received so far, which may be empty. */
  pendingText?: string;
};

function skipSpace(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text.charAt(index))) index += 1;
  return index;
}

/** Reads a string token that starts at `from`; `undefined` while its closing quote has not arrived. */
function readStringToken(text: string, from: number): { value: string; end: number } | undefined {
  let index = from + 1;
  while (index < text.length) {
    const character = text.charAt(index);
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '"') {
      try {
        const value: unknown = JSON.parse(text.slice(from, index + 1));
        return typeof value === 'string' ? { value, end: index + 1 } : undefined;
      } catch {
        return undefined;
      }
    }
    index += 1;
  }
  return undefined;
}

/** The index just past a whole value that starts at `from`, or -1 while it is still arriving. */
function findValueEnd(text: string, from: number): number {
  const first = text.charAt(from);
  if (first === '"') return readStringToken(text, from)?.end ?? -1;
  if (first === '{' || first === '[') {
    let depth = 0;
    for (let index = from; index < text.length; index += 1) {
      const character = text.charAt(index);
      if (character === '"') {
        const token = readStringToken(text, index);
        if (token === undefined) return -1;
        index = token.end - 1;
      } else if (character === '{' || character === '[') {
        depth += 1;
      } else if (character === '}' || character === ']') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return -1;
  }
  // A number or a keyword could still be growing, so it is whole only once a delimiter follows it.
  let index = from;
  while (index < text.length && !/[\s,}\]]/.test(text.charAt(index))) index += 1;
  return index < text.length ? index : -1;
}

/**
 * Reads what has arrived of a JSON object that is still being written. A field appears once its
 * value is whole; the key whose value is not yet whole is returned as the pending key. Returns
 * `undefined` when the text is not an object at all.
 */
export function readPartialObject(text: string): PartialObject | undefined {
  let index = skipSpace(text, 0);
  if (text.charAt(index) !== '{') return undefined;
  index += 1;
  const entries: [string, unknown][] = [];
  for (;;) {
    index = skipSpace(text, index);
    const character = text.charAt(index);
    if (index >= text.length || character === '}') return { entries };
    if (character === ',') {
      index += 1;
      continue;
    }
    if (character !== '"') return { entries };
    const key = readStringToken(text, index);
    if (key === undefined) return { entries };
    index = skipSpace(text, key.end);
    if (text.charAt(index) !== ':') {
      return index >= text.length
        ? { entries, pendingKey: key.value, pendingText: '' }
        : { entries };
    }
    index = skipSpace(text, index + 1);
    const end = index >= text.length ? -1 : findValueEnd(text, index);
    if (end < 0) return { entries, pendingKey: key.value, pendingText: text.slice(index) };
    try {
      entries.push([key.value, JSON.parse(text.slice(index, end))]);
    } catch {
      return { entries, pendingKey: key.value, pendingText: text.slice(index) };
    }
    index = end;
  }
}

/** What every part of the Fields view reads from the card, so it travels as one value. */
export type FieldsOptions = {
  /** Where a value in the Fields view leads, when it names something. */
  linkFor?: ((field: PayloadInspectorField) => string | undefined) | undefined;
  /** The caller's own writing of a value, keyed by path. */
  formatValue?: ((field: PayloadInspectorField) => string | undefined) | undefined;
  /** How deep an object nested in the Fields view starts open. */
  initialDepth: number;
  /** How deep the Fields view goes before it stops. */
  maxDepth: number;
  /** True when the payload sits in a tree: objects nest, so each nested value can collapse. */
  tree: boolean;
};

/** True when a payload's top-level values include a nested object, which draws the collapsible tree. */
export function isTreePayload(source: unknown): boolean {
  if (!isPlainRecord(source)) return false;
  return Object.values(source).some(isPlainRecord);
}
