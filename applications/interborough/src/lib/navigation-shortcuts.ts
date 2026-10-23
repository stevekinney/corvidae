/**
 * The keyboard shortcuts that open a view: `g`, then one letter, as in `g c` for Chat. The
 * sidebar shows each in its item's tooltip and the shell listens for them, so what a tooltip says
 * is what the keys do. This module is the one list, and the pure step that reads a key against it.
 */

/** The letter that follows `g` for each view's path. Each letter is used once. */
export const NAVIGATION_SHORTCUTS: Readonly<Record<string, string>> = {
  '/chat': 'c',
  '/agents': 'a',
  '/workflows': 'w',
  '/runs': 'r',
  '/schedules': 's',
  '/reviews': 'v',
  '/workers': 'o',
  '/storage': 't',
  '/system': 'y',
  '/audit': 'u',
};

/** How long after `g` the second key still counts. */
export const CHORD_WINDOW_MS = 1_000;

const PATH_BY_LETTER: ReadonlyMap<string, string> = new Map(
  Object.entries(NAVIGATION_SHORTCUTS).map(([path, letter]) => [letter, path]),
);

/** The key sequence of `path`'s shortcut, such as `['g', 'c']`, or `undefined` for a path with none. */
export function shortcutKeys(path: string): string[] | undefined {
  const letter = NAVIGATION_SHORTCUTS[path];
  return letter === undefined ? undefined : ['g', letter];
}

/** The part of a key event the chord reads, so a test needs no DOM. */
export interface ChordKey {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  /** Whether the key went to something the person is typing into. */
  readonly editable: boolean;
}

/** What one key did: the new moment `g` was pressed (or `null` when no chord is waiting), and the path to open, if any. */
export interface ChordStep {
  readonly armedAtMs: number | null;
  readonly path: string | null;
}

/**
 * Reads one key against the chord. `g` waits for a letter; the letter of a view, within
 * {@link CHORD_WINDOW_MS}, opens it; anything else, a modifier, or typing into a field drops the
 * wait. A shifted letter is not the shortcut: `Shift+G` is a different key.
 */
export function stepChord(armedAtMs: number | null, event: ChordKey, nowMs: number): ChordStep {
  if (event.editable || event.metaKey || event.ctrlKey || event.altKey) {
    return { armedAtMs: null, path: null };
  }
  const waiting = armedAtMs !== null && nowMs - armedAtMs <= CHORD_WINDOW_MS;
  if (waiting) {
    const path = PATH_BY_LETTER.get(event.key);
    if (path !== undefined) return { armedAtMs: null, path };
  }
  return { armedAtMs: event.key === 'g' ? nowMs : null, path: null };
}
