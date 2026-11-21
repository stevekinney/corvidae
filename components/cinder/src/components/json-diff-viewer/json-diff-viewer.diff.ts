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
};

/** The key of the compared values themselves, when they are not the entries of a collection. */
export const ROOT_KEY = '(root)';

/** How many entries of a level render before the rest wait behind a control to show more. */
export const JSON_DIFF_PAGE_SIZE = 200;

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

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function cut(text: string): string {
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

/**
 * A one-line preview of a value: a primitive as JSON, a collection as its size. A collection's
 * contents are never walked, so the preview of a very large value costs nothing.
 */
export function previewJsonValue(value: unknown): string {
  const shape = shapeOf(value);
  if (shape === 'array') return `[${pluralize((value as unknown[]).length, 'item', 'items')}]`;
  if (shape === 'object') {
    return `{${pluralize(definedEntries(value as Record<string, unknown>).length, 'key', 'keys')}}`;
  }
  if (shape === 'string') return cut(JSON.stringify(value));
  if (shape === 'other') return cut(String(value));
  return String(value);
}

/** An object's own entries, without the ones JSON would drop for holding `undefined`. */
function definedEntries(record: Record<string, unknown>): [string, unknown][] {
  return Object.entries(record).filter(([, entry]) => entry !== undefined);
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

/** The entries one pair of values contributes at `key`: none, one, or two on a type change. */
function compareEntry(
  key: string,
  before: unknown,
  after: unknown,
  depth: number,
  maxDepth: number,
): JsonDiffEntry[] {
  const beforeShape = shapeOf(before);
  const afterShape = shapeOf(after);

  if (beforeShape !== afterShape) {
    return [leaf(key, 'removed', before), leaf(key, 'added', undefined, after)];
  }

  if (beforeShape === 'array' || beforeShape === 'object') {
    if (depth >= maxDepth) {
      // Past the cap the collections are compared whole, never walked.
      const equal = JSON.stringify(before) === JSON.stringify(after);
      return [equal ? leaf(key, 'unchanged', before) : leaf(key, 'changed', before, after)];
    }
    const children = compareCollection(before, after, beforeShape === 'array', depth + 1, maxDepth);
    if (children.changes.length === 0) return [leaf(key, 'unchanged', before)];
    return [{ id: `changed:${key}`, key, kind: 'changed', children }];
  }

  return [before === after ? leaf(key, 'unchanged', before) : leaf(key, 'changed', before, after)];
}

function compareCollection(
  before: unknown,
  after: unknown,
  isArray: boolean,
  depth: number,
  maxDepth: number,
): JsonDiffLevel {
  const changes: JsonDiffEntry[] = [];
  const unchanged: JsonDiffEntry[] = [];
  const place = (entries: JsonDiffEntry[]): void => {
    for (const entry of entries) (entry.kind === 'unchanged' ? unchanged : changes).push(entry);
  };

  if (isArray) {
    // Arrays compare by index: inserting at the front shows as every later index changing.
    const beforeItems = before as unknown[];
    const afterItems = after as unknown[];
    const length = Math.max(beforeItems.length, afterItems.length);
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (index >= afterItems.length) place([leaf(key, 'removed', beforeItems[index])]);
      else if (index >= beforeItems.length)
        place([leaf(key, 'added', undefined, afterItems[index])]);
      else place(compareEntry(key, beforeItems[index], afterItems[index], depth, maxDepth));
    }
    return { changes, unchanged };
  }

  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const afterKeys = new Map(definedEntries(afterRecord));
  const seen = new Set<string>();
  for (const [key, beforeValue] of definedEntries(beforeRecord)) {
    seen.add(key);
    if (afterKeys.has(key)) {
      place(compareEntry(key, beforeValue, afterKeys.get(key), depth, maxDepth));
    } else {
      place([leaf(key, 'removed', beforeValue)]);
    }
  }
  for (const [key, afterValue] of afterKeys) {
    if (!seen.has(key)) place([leaf(key, 'added', undefined, afterValue)]);
  }
  return { changes, unchanged };
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
  if (beforeShape === shapeOf(after) && (beforeShape === 'array' || beforeShape === 'object')) {
    return compareCollection(before, after, beforeShape === 'array', 1, maxDepth);
  }
  const entries = compareEntry(ROOT_KEY, before, after, 0, maxDepth);
  return {
    changes: entries.filter((entry) => entry.kind !== 'unchanged'),
    unchanged: entries.filter((entry) => entry.kind === 'unchanged'),
  };
}
