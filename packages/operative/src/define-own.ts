/**
 * Stores `value` as an own entry of `record` under `key`. Plain assignment treats the key
 * `__proto__` as "set the prototype", so an id or field name that arrives from outside would
 * silently vanish (or replace the record's prototype) instead of being stored.
 */
export function defineOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
