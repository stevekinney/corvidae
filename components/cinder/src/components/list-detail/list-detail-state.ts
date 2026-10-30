import type { ListDetailSelectionLocation, ListDetailStorage } from './list-detail.types.ts';

/** Narrowest the list pane may be dragged, in pixels. */
export const LIST_PANE_MINIMUM_WIDTH = 200;
/** Widest the list pane may be dragged, in pixels. */
export const LIST_PANE_MAXIMUM_WIDTH = 560;
/** Narrowest the detail pane may be left by dragging the divider, in pixels. */
export const DETAIL_PANE_MINIMUM_WIDTH = 320;

/** Keeps a list width inside the range the divider can reach. */
export function clampListWidth(width: number): number {
  return Math.min(LIST_PANE_MAXIMUM_WIDTH, Math.max(LIST_PANE_MINIMUM_WIDTH, width));
}

/**
 * The storage ListDetail remembers the divider in: the one passed in, else `localStorage`. Reading
 * `localStorage` can throw (blocked site data, a sandboxed frame), and there is none on the server,
 * so the result is `undefined` when it is unavailable.
 */
export function resolveStorage(
  storage: ListDetailStorage | undefined,
): ListDetailStorage | undefined {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Reads the remembered list width, or `null` when nothing usable is stored under `storageKey`. */
export function readStoredListWidth(
  storage: ListDetailStorage | undefined,
  storageKey: string | undefined,
): number | null {
  if (!storage || storageKey === undefined) return null;
  try {
    const stored = storage.getItem(storageKey);
    if (stored === null || stored.trim() === '') return null;
    const width = Number(stored);
    return Number.isFinite(width) ? clampListWidth(width) : null;
  } catch {
    return null;
  }
}

/** Remembers the list width under `storageKey`. A storage that refuses the write is ignored. */
export function writeStoredListWidth(
  storage: ListDetailStorage | undefined,
  storageKey: string | undefined,
  width: number,
): void {
  if (!storage || storageKey === undefined) return;
  try {
    storage.setItem(storageKey, String(Math.round(width)));
  } catch {
    // The divider still moves; it is just not remembered.
  }
}

/** Reads and writes the selection through `window.location` and `history.replaceState`. */
export function createBrowserSelectionLocation(): ListDetailSelectionLocation {
  return {
    read(parameter) {
      if (typeof window === 'undefined') return null;
      return new URL(window.location.href).searchParams.get(parameter);
    },
    write(parameter, key) {
      if (typeof window === 'undefined') return;
      const url = new URL(window.location.href);
      if (key === null) url.searchParams.delete(parameter);
      else url.searchParams.set(parameter, key);
      window.history.replaceState(window.history.state, '', url);
    },
  };
}

/**
 * The key the keyboard cursor moves to from `current`, one row in `direction`, stopping at either
 * end. With no cursor yet, or a cursor on a row that is gone, it lands on the first row. Returns
 * `null` when there are no rows.
 */
export function moveCursor(
  keys: readonly string[],
  current: string | null,
  direction: 1 | -1,
): string | null {
  if (keys.length === 0) return null;
  const index = current === null ? -1 : keys.indexOf(current);
  if (index === -1) return keys[0] ?? null;
  const next = Math.min(keys.length - 1, Math.max(0, index + direction));
  return keys[next] ?? null;
}

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
const OVERLAY_SELECTOR = '[role="menu"], [role="listbox"], [role="dialog"], [role="combobox"]';

/**
 * True when a key typed at `target` belongs to that target: a field the person is typing in, or a
 * menu, listbox, dialog or combobox that uses letters for its own typeahead.
 */
export function ownsTypedKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(EDITABLE_SELECTOR) !== null || target.closest(OVERLAY_SELECTOR) !== null;
}
