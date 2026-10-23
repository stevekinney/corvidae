/**
 * Which notifications the person has read, kept in this browser so a reload does not make every
 * finished run new again. Storage can be missing or refuse a read or a write (a private window,
 * blocked site data), so every access is guarded and the bell works without it.
 */
const STORAGE_KEY = 'interborough:notifications:read';

/** How many read ids are kept; the oldest go first. */
export const READ_ID_LIMIT = 200;

export interface ReadIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): ReadIdStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The ids read before, oldest first; empty when nothing is stored or what is stored is not a list of ids. */
export function loadReadIds(storage: ReadIdStorage | undefined = defaultStorage()): string[] {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (stored === null || stored === undefined) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string').slice(-READ_ID_LIMIT);
  } catch {
    return [];
  }
}

/** Keeps the newest {@link READ_ID_LIMIT} ids; a write storage refuses is dropped. */
export function saveReadIds(
  ids: readonly string[],
  storage: ReadIdStorage | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-READ_ID_LIMIT)));
  } catch {
    // The read state then lasts until the page closes.
  }
}
