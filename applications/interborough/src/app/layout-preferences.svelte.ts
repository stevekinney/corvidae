/**
 * The shell's personal layout preference, kept in `localStorage` as the theme is
 * (`theme.svelte.ts`): whether the sidebar is folded to its icon rail at 1024px and wider. It is
 * set from the top bar's quick settings popover and from the sidebar's own toggle, and it survives
 * a reload. There is no density preference: one density everywhere (design row 02y).
 */
import { getContext, setContext } from 'svelte';

const SIDEBAR_KEY = 'interborough-sidebar-collapsed';

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

/** The sidebar's collapsed state, read from and written to storage. */
export class LayoutPreferences {
  /** Whether the sidebar is folded to its icon rail on a desktop viewport. */
  sidebarCollapsed: boolean = $state(false);

  readonly #storage: Storage;

  constructor(storage: Storage = window.localStorage) {
    this.#storage = storage;
    this.sidebarCollapsed = read(storage, SIDEBAR_KEY) === 'true';
  }

  /** Sets and stores whether the sidebar is folded to its icon rail. */
  setSidebarCollapsed(collapsed: boolean): void {
    this.sidebarCollapsed = collapsed;
    write(this.#storage, SIDEBAR_KEY, String(collapsed));
  }
}

const LAYOUT_PREFERENCES_KEY = Symbol('layout-preferences');

/** Makes the shell's preferences available to the components under it, such as the route outlet. */
export function provideLayoutPreferences(preferences: LayoutPreferences): LayoutPreferences {
  setContext(LAYOUT_PREFERENCES_KEY, preferences);
  return preferences;
}

/** The shell's preferences, or `undefined` under a component mounted without the shell. */
export function getLayoutPreferences(): LayoutPreferences | undefined {
  return getContext<LayoutPreferences | undefined>(LAYOUT_PREFERENCES_KEY);
}
