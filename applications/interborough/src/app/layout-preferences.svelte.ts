/**
 * The shell's personal layout preferences, kept in `localStorage` as the theme is
 * (`theme.svelte.ts`): the density every page is shown at, and whether the sidebar is folded to
 * its icon rail. They are set from the top bar's quick settings popover and from the sidebar's
 * own toggle, and they survive a reload.
 */
import { getContext, setContext } from 'svelte';

import type { ViewDensity } from './views.ts';

const DENSITY_KEY = 'interborough-density';
const SIDEBAR_KEY = 'interborough-sidebar-collapsed';

/**
 * The density preference: `comfortable` shows each view at the density it declares
 * (`views.ts`), and `compact` shows every view at the compact density.
 */
export type DensityPreference = 'comfortable' | 'compact';

/** The density a view is shown at, given its own and the person's preference. */
export function effectiveDensity(view: ViewDensity, preference: DensityPreference): ViewDensity {
  return preference === 'compact' ? 'compact' : view;
}

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

/** The density preference and the sidebar's collapsed state, read from and written to storage. */
export class LayoutPreferences {
  /** The density preference. */
  density: DensityPreference = $state('comfortable');
  /** Whether the sidebar is folded to its icon rail on a desktop viewport. */
  sidebarCollapsed: boolean = $state(false);

  readonly #storage: Storage;

  constructor(storage: Storage = window.localStorage) {
    this.#storage = storage;
    this.density = read(storage, DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
    this.sidebarCollapsed = read(storage, SIDEBAR_KEY) === 'true';
  }

  /** Sets and stores the density preference. */
  setDensity(density: DensityPreference): void {
    this.density = density;
    write(this.#storage, DENSITY_KEY, density);
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
