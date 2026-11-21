/**
 * The structural comparison behind JsonDiffViewer: two JSON values in, a tree of what changed out.
 * Pure data with no DOM, so the component renders it and the tests read it directly.
 */

/** How one entry differs between the two values. */
export type JsonDiffKind = 'added' | 'removed' | 'changed' | 'unchanged';

/** The entries of one object or array, split into what differs and what does not. */
export type JsonDiffLevel = {
  /** Added, removed and changed entries, in the order their keys first appear. */
  readonly changes: readonly JsonDiffEntry[];
  /** Entries present and equal on both sides, in the same order. */
  readonly unchanged: readonly JsonDiffEntry[];
};

/** One entry of a diff: a key and how its value differs. */
export type JsonDiffEntry = {
  /** Unique within its level: the kind joined to the key, since a type change yields two entries. */
  readonly id: string;
  /** The property name, the array index as text, or {@link ROOT_KEY} for the compared values. */
  readonly key: string;
  readonly kind: JsonDiffKind;
  /** A one-line preview of the value before; present for `removed`, `changed` and `unchanged`. */
  readonly before?: string;
  /** A one-line preview of the value after; present for `added` and `changed`. */
  readonly after?: string;
  /** The nested differences of an object or array that changed in place. */
  readonly children?: JsonDiffLevel;
  /**
   * Set by the render budget on a nested level that would push the first render past
   * {@link JSON_DIFF_ELEMENT_BUDGET}: it starts closed behind a control. Never set on a level
   * that fits.
   */
  collapsed?: boolean;
};

/** The key of the compared values themselves, when they are not the entries of a collection. */
export const ROOT_KEY = '(root)';

/** How many entries of a level render before the rest wait behind a control to show more. */
export const JSON_DIFF_PAGE_SIZE = 200;

/**
 * How many elements the first render may create. Each level is capped at a page, but pages of
 * nested levels add up, so a nested level opens by default only while its page still fits.
 */
export const JSON_DIFF_ELEMENT_BUDGET = 900;

/** The elements one row creates: its item, marker, key, and value or control. */
const ELEMENTS_PER_ROW = 4;

/** The elements a level creates besides its rows: its list, and its two controls with their items. */
const ELEMENTS_PER_LEVEL = 5;

/** The longest preview of a value before it is cut with an ellipsis. */
const PREVIEW_LIMIT = 120;

type JsonShape = 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'other';

function shapeOf(value: unknown): JsonShape {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'object':
      return 'object';
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'other';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return shapeOf(value) === 'object';
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function cut(text: string): string {
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

/** An object's own entries, without the ones JSON would drop for holding `undefined`. */
function definedEntries(record: Record<string, unknown>): [string, unknown][] {
  return Object.entries(record).filter(([, entry]) => entry !== undefined);
}

/**
 * A one-line preview of a value: a primitive as JSON, a collection as its size. A collection's
 * contents are never walked, so the preview of a very large value costs nothing.
 */
export function previewJsonValue(value: unknown): string {
  if (Array.isArray(value)) return `[${pluralize(value.length, 'item', 'items')}]`;
  if (isRecord(value)) return `{${pluralize(definedEntries(value).length, 'key', 'keys')}}`;
  if (typeof value === 'string') return cut(JSON.stringify(value));
  if (shapeOf(value) === 'other') return cut(String(value));
  return String(value);
}

/** The JSON text of a value, or `null` when it cannot be serialized. */
function serializeOrNull(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function leaf(key: string, kind: JsonDiffKind, before?: unknown, after?: unknown): JsonDiffEntry {
  return {
    id: `${kind}:${key}`,
    key,
    kind,
    ...(kind === 'added' ? {} : { before: previewJsonValue(before) }),
    ...(kind === 'added' || kind === 'changed' ? { after: previewJsonValue(after) } : {}),
  };
}

/** The entries one pair of values contributes at `key`: one, or two on a type change. */
function compareEntry(
  key: string,
  before: unknown,
  after: unknown,
  depth: number,
  maxDepth: number,
): JsonDiffEntry[] {
  const beforeShape = shapeOf(before);

  if (beforeShape !== shapeOf(after)) {
    return [leaf(key, 'removed', before), leaf(key, 'added', undefined, after)];
  }

  if (beforeShape === 'array' || beforeShape === 'object') {
    if (depth >= maxDepth) {
      // Past the cap the collections are compared whole, never walked. A value JSON cannot
      // serialize (a circular reference, a BigInt) is never equal to anything, so it shows changed.
      const serialized = [serializeOrNull(before), serializeOrNull(after)];
      const equal = serialized[0] !== null && serialized[0] === serialized[1];
      return [equal ? leaf(key, 'unchanged', before) : leaf(key, 'changed', before, after)];
    }
    const children = compareCollection(before, after, depth + 1, maxDepth);
    if (children.changes.length === 0) return [leaf(key, 'unchanged', before)];
    return [{ id: `changed:${key}`, key, kind: 'changed', children }];
  }

  return [before === after ? leaf(key, 'unchanged', before) : leaf(key, 'changed', before, after)];
}

/** Compare two arrays by index, or two objects by key. The caller has matched their shapes. */
function compareCollection(
  before: unknown,
  after: unknown,
  depth: number,
  maxDepth: number,
): JsonDiffLevel {
  const changes: JsonDiffEntry[] = [];
  const unchanged: JsonDiffEntry[] = [];
  const place = (entries: JsonDiffEntry[]): void => {
    for (const entry of entries) (entry.kind === 'unchanged' ? unchanged : changes).push(entry);
  };

  if (Array.isArray(before) && Array.isArray(after)) {
    // Arrays compare by index: inserting at the front shows as every later index changing.
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (index >= after.length) place([leaf(key, 'removed', before[index])]);
      else if (index >= before.length) place([leaf(key, 'added', undefined, after[index])]);
      else place(compareEntry(key, before[index], after[index], depth, maxDepth));
    }
  } else if (isRecord(before) && isRecord(after)) {
    const afterEntries = new Map(definedEntries(after));
    const seen = new Set<string>();
    for (const [key, beforeValue] of definedEntries(before)) {
      seen.add(key);
      if (afterEntries.has(key)) {
        place(compareEntry(key, beforeValue, afterEntries.get(key), depth, maxDepth));
      } else {
        place([leaf(key, 'removed', beforeValue)]);
      }
    }
    for (const [key, afterValue] of afterEntries) {
      if (!seen.has(key)) place([leaf(key, 'added', undefined, afterValue)]);
    }
  }
  return { changes, unchanged };
}

/**
 * Charge the first page of `level` against the budget, then open each nested level whose own page
 * still fits and close the rest. Rows past the first page only render when a control asks, so they
 * cost nothing here.
 */
function spendBudget(level: JsonDiffLevel, remaining: { elements: number }): void {
  const page = level.changes.slice(0, JSON_DIFF_PAGE_SIZE);
  remaining.elements -= page.length * ELEMENTS_PER_ROW + ELEMENTS_PER_LEVEL;
  for (const entry of page) {
    const { children } = entry;
    if (children === undefined) continue;
    const cost =
      Math.min(children.changes.length, JSON_DIFF_PAGE_SIZE) * ELEMENTS_PER_ROW +
      ELEMENTS_PER_LEVEL;
    if (cost > remaining.elements) entry.collapsed = true;
    else spendBudget(children, remaining);
  }
}

/**
 * Compare two JSON values. Objects compare by key and arrays by index, to any depth up to
 * `maxDepth`; a value whose type differs shows as one removed and one added entry. When the two
 * are equal the result has no changes. Values that are not JSON (`undefined`, functions, symbols)
 * are previewed as text; an object property holding `undefined` is treated as absent, as
 * `JSON.stringify` treats it.
 */
export function diffJsonValues(before: unknown, after: unknown, maxDepth = 50): JsonDiffLevel {
  const beforeShape = shapeOf(before);
  let level: JsonDiffLevel;
  if (beforeShape === shapeOf(after) && (beforeShape === 'array' || beforeShape === 'object')) {
    level = compareCollection(before, after, 1, maxDepth);
  } else {
    const entries = compareEntry(ROOT_KEY, before, after, 0, maxDepth);
    level = {
      changes: entries.filter((entry) => entry.kind !== 'unchanged'),
      unchanged: entries.filter((entry) => entry.kind === 'unchanged'),
    };
  }
  spendBudget(level, { elements: JSON_DIFF_ELEMENT_BUDGET });
  return level;
}
