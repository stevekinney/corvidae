/**
 * Reads `record[key]` only when `key` is an own property of `record`, so an id such as
 * `constructor` finds nothing in a record that lacks it instead of `Object`.
 *
 * The read comes first on purpose: on a Svelte `$state` proxy, reading a key subscribes to it even
 * while it is absent, but `Object.hasOwn` does not, so a message added later would not re-run a
 * derived value that asked for it before it existed.
 */
export function getOwn<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  const value = record[key];
  return Object.hasOwn(record, key) ? value : undefined;
}
