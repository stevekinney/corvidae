/**
 * Which storage keys the application manages. A key under a Weft-reserved prefix
 * (`WEFT_RESERVED_KEY_PREFIXES`, public from `@lostgradient/weft`) or a Bureau-reserved one
 * (`BUREAU_RESERVED_KEY_PREFIXES`, which only the host can import, so the page reads it from
 * `/host/storage`) belongs to the engine or the Bureau: the explorer shows it and refuses to edit or
 * delete it. Only a key under neither can be changed from here.
 */
import { WEFT_RESERVED_KEY_PREFIXES } from '@lostgradient/weft';

export { WEFT_RESERVED_KEY_PREFIXES };

/** The managed prefix `key` falls under, or `undefined` when no list names it. */
export function managedPrefix(key: string, bureauPrefixes: readonly string[]): string | undefined {
  return (
    WEFT_RESERVED_KEY_PREFIXES.find((prefix) => key.startsWith(prefix)) ??
    bureauPrefixes.find((prefix) => key.startsWith(prefix))
  );
}

/** Whether `key` is one the application manages, so it cannot be edited or deleted here. */
export function isManagedKey(key: string, bureauPrefixes: readonly string[]): boolean {
  return managedPrefix(key, bureauPrefixes) !== undefined;
}

/** A write the explorer refuses: the key is managed, or the managed prefixes are not known yet. */
export class WriteRefusedError extends Error {}

/**
 * Throws {@link WriteRefusedError} unless `key` can be changed from here: the Bureau's prefixes are
 * known, and neither they nor Weft's name the key. Every write goes through this, so a control that
 * appears by mistake still cannot change a managed key.
 */
export function assertWritable(
  key: string,
  bureauPrefixes: readonly string[] | undefined,
  refusal: (prefix: string | undefined) => string,
): void {
  if (bureauPrefixes === undefined) throw new WriteRefusedError(refusal(undefined));
  const prefix = managedPrefix(key, bureauPrefixes);
  if (prefix !== undefined) throw new WriteRefusedError(refusal(prefix));
}
