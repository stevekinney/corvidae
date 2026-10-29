/**
 * Reads `record[key]` only when `key` is an own property of `record`. A plain record also answers
 * for the names every object inherits, so a run or review id such as `constructor` would otherwise
 * find `Object` where it should find nothing.
 */
export function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
