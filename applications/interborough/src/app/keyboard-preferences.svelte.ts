/**
 * The personal keyboard preference, kept in `localStorage` as the theme and the sidebar are
 * (`theme.svelte.ts`, `layout-preferences.svelte.ts`): whether the shortcuts pressed without a
 * modifier (the G sequences, C and the rest of the plain keys) answer. It is on until a person
 * turns it off with "Use single-key shortcuts" in Settings (design row 03f), and the shell hands
 * it to the shortcut registry, which is what stops them acting.
 */
import { getContext, setContext } from 'svelte';

const SINGLE_KEY_STORAGE_KEY = 'interborough-single-key-shortcuts';

/** A storage read that cannot fail the shell over a cosmetic preference. */
function read(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** A storage write that keeps the preference for this session when storage refuses it. */
function write(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Storage that is full or blocked keeps the preference for this session only.
  }
}

/** Whether single-key shortcuts answer, read from and written to storage. */
export class KeyboardPreferences {
  /** Whether the shortcuts pressed without a modifier answer. On by default. */
  singleKeyShortcuts: boolean = $state(true);

  readonly #storage: Storage;

  constructor(storage: Storage = window.localStorage) {
    this.#storage = storage;
    this.singleKeyShortcuts = read(storage, SINGLE_KEY_STORAGE_KEY) !== 'false';
  }

  /** Sets and stores whether the shortcuts pressed without a modifier answer. */
  setSingleKeyShortcuts(enabled: boolean): void {
    this.singleKeyShortcuts = enabled;
    write(this.#storage, SINGLE_KEY_STORAGE_KEY, String(enabled));
  }
}

const KEYBOARD_PREFERENCES_KEY = Symbol('keyboard-preferences');

/** Makes the keyboard preference available to the components under the shell, such as Settings. */
export function provideKeyboardPreferences(preferences: KeyboardPreferences): KeyboardPreferences {
  setContext(KEYBOARD_PREFERENCES_KEY, preferences);
  return preferences;
}

/** The keyboard preference, or `undefined` under a component mounted without the shell. */
export function getKeyboardPreferences(): KeyboardPreferences | undefined {
  return getContext<KeyboardPreferences | undefined>(KEYBOARD_PREFERENCES_KEY);
}
