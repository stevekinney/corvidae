/**
 * Reads `record[key]` only when `key` is an own property of `record`. A plain record also answers
 * for the names every object inherits, so a field, token, or column named `constructor` would
 * otherwise find `Object` where it should find nothing.
 *
 * The read comes first on purpose: on a Svelte `$state` proxy, reading a key subscribes to it even
 * while it is absent, but `Object.hasOwn` does not, so a key added later would not re-run a
 * derived value that asked for it before it existed.
 */
export function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  const value = record[key];
  return Object.hasOwn(record, key) ? value : undefined;
}
