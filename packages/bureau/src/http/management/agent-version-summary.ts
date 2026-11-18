/**
 * What one saved version of an agent changed, in words (COR-2429, rows 38x and 38z of COR-2020):
 * the `summary` `bureau.agents.versions.list` gives beside `changedKeys`, such as
 * `Instructions: added “Refunds over $25 need approval.”; Tools: added issue-refund`. It is read
 * from the version's own content and the version before it, so it says what changed, not only
 * which keys did: the lines the instructions gained or lost, the entries a list gained or lost, and
 * a value's old and new form. It is deterministic, never written by a model, and names tools and
 * models by their identifiers, which a client may word as it reads them.
 *
 * @module agent-version-summary
 */

/** The longest quoted line a summary holds before it is cut with an ellipsis. */
const QUOTE_LIMIT = 60;

/** What the summary calls a key: its camel-cased words, the first capitalized (`stopWhen` is `Stop when`). */
function labelOf(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `text` on one line, cut to {@link QUOTE_LIMIT} characters with an ellipsis. */
function quoted(text: string): string {
  const line = text.trim().replace(/\s+/g, ' ');
  const cut = line.length > QUOTE_LIMIT ? `${line.slice(0, QUOTE_LIMIT - 1).trimEnd()}…` : line;
  return `“${cut}”`;
}

/** `items` as a person lists them: `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** The lines of `text` that hold anything, trimmed. */
function linesOf(text: unknown): string[] {
  return typeof text === 'string'
    ? text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    : [];
}

function instructionsChange(current: unknown, previous: unknown): string {
  const before = new Set(linesOf(previous));
  const after = new Set(linesOf(current));
  const added = [...after].filter((line) => !before.has(line));
  const removed = [...before].filter((line) => !after.has(line));
  const more = (count: number): string =>
    count <= 1 ? '' : ` and ${String(count - 1)} more line${count === 2 ? '' : 's'}`;
  const parts = [
    ...(added[0] === undefined ? [] : [`added ${quoted(added[0])}${more(added.length)}`]),
    ...(removed[0] === undefined ? [] : [`removed ${quoted(removed[0])}${more(removed.length)}`]),
  ];
  return parts.length === 0 ? 'rewrote' : parts.join(', ');
}

/** A value as a summary shows it, or `undefined` for one it cannot show in a few words. */
function shown(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : quotedIfLong(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function quotedIfLong(value: string): string {
  return value.includes(' ') || value.length > QUOTE_LIMIT ? quoted(value) : value;
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * A tool or skill as a person reads it: its name after any `plugin:` namespace, its separators as
 * spaces, the first letter capitalized (`issue-refund` is "Issue refund"), as the agent page names it.
 */
function displayNameOf(identifier: string): string {
  const bare = identifier
    .slice(identifier.indexOf(':') + 1)
    .replace(/[-_]+/g, ' ')
    .trim();
  return bare === '' ? identifier : bare.charAt(0).toUpperCase() + bare.slice(1);
}

/** The keys whose entries are named for a person to read, not as identifiers. */
const NAMED_LISTS: ReadonlySet<string> = new Set(['tools', 'skills']);

function listChange(
  current: readonly string[],
  previous: readonly string[],
  name: (entry: string) => string,
): string {
  const before = new Set(previous);
  const after = new Set(current);
  const added = current.filter((entry) => !before.has(entry)).map(name);
  const removed = previous.filter((entry) => !after.has(entry)).map(name);
  const parts = [
    ...(added.length === 0 ? [] : [`added ${listed(added)}`]),
    ...(removed.length === 0 ? [] : [`removed ${listed(removed)}`]),
  ];
  return parts.length === 0 ? 'reordered' : parts.join(', ');
}

function isScalarRecord(
  value: unknown,
): value is Readonly<Record<string, string | number | boolean>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (entry) =>
        typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
    )
  );
}

/**
 * What a record of single values (an agent's `approvals`, tool to how it asks) changed: each entry
 * set, changed or removed, by name, such as "Issue refund always, Lookup order removed".
 */
function recordChange(
  current: Readonly<Record<string, string | number | boolean>>,
  previous: Readonly<Record<string, string | number | boolean>>,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(current)) {
    const before = Object.hasOwn(previous, key) ? previous[key] : undefined;
    if (before !== value) parts.push(`${displayNameOf(key)} ${String(value)}`);
  }
  for (const key of Object.keys(previous)) {
    if (!Object.hasOwn(current, key)) parts.push(`${displayNameOf(key)} removed`);
  }
  return parts.length === 0 ? 'changed' : parts.join(', ');
}

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

/** What one key's change says, after its label. */
function changeOf(key: string, current: unknown, previous: unknown): string {
  if (key === 'instructions') return instructionsChange(current, previous);
  if (isStringList(current) || isStringList(previous)) {
    const name = NAMED_LISTS.has(key) ? displayNameOf : (entry: string) => entry;
    return listChange(
      isStringList(current) ? current : [],
      isStringList(previous) ? previous : [],
      name,
    );
  }
  if (
    (isScalarRecord(current) || absent(current)) &&
    (isScalarRecord(previous) || absent(previous)) &&
    !(absent(current) && absent(previous))
  ) {
    return recordChange(
      isScalarRecord(current) ? current : {},
      isScalarRecord(previous) ? previous : {},
    );
  }
  const now = shown(current);
  const before = shown(previous);
  if (absent(current) || now === undefined) {
    return absent(current) ? (absent(previous) ? 'changed' : 'cleared') : 'changed';
  }
  if (absent(previous) || before === undefined)
    return absent(previous) ? `set to ${now}` : 'changed';
  return `${before} to ${now}`;
}

/** A plain record, or an empty one for anything else. */
function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The summary of a version that changed `changedKeys` from `previous` to `current`: `Created` for
 * an agent's first version (`first`), `Saved with no change` for a save that changed nothing, and
 * otherwise each changed key's change, in `changedKeys` order, joined by semicolons. `previous` is
 * `undefined` when the version before it is no longer kept, and each key then says only that it
 * changed.
 */
export function summarizeVersion(input: {
  readonly changedKeys: readonly string[];
  readonly current: unknown;
  readonly previous: unknown;
  readonly first: boolean;
}): string {
  if (input.first) return 'Created';
  if (input.changedKeys.length === 0) return 'Saved with no change';
  const current = recordOf(input.current);
  const previous = input.previous === undefined ? undefined : recordOf(input.previous);
  return input.changedKeys
    .map((key) => {
      const label = labelOf(key);
      if (previous === undefined) return `${label}: changed`;
      const now = Object.hasOwn(current, key) ? current[key] : undefined;
      const before = Object.hasOwn(previous, key) ? previous[key] : undefined;
      return `${label}: ${changeOf(key, now, before)}`;
    })
    .join('; ');
}
