/**
 * How the shell shows its navigation (design rows 04a to 04c):
 *
 * - `expanded`: at 1200px and wider the sidebar is in the page, 190px wide, or folded to its 56px
 *   icon rail when the person chose that in quick settings (the only place that choice applies).
 * - `drawer`: below 1200px the top bar opens the full navigation in a 280px drawer, whether the
 *   person is using a pointer or touch. Under 700px, the bottom tab bar adds direct links and another
 *   way to open the drawer.
 *
 * The sidebar, top bar and phone tabs share the drawer's open state.
 */
import { getContext, setContext } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';

import type { LayoutPreferences } from '../layout-preferences.svelte.ts';

/** The viewport width at and above which the sidebar stays in the page, in CSS pixels. */
export const DESKTOP_MINIMUM_WIDTH = 1200;

/** The first viewport width without phone tabs, in CSS pixels. */
const PHONE_TAB_LIMIT = 700;

/** The widest viewport that uses the drawer, as a CSS length for `Sidebar`. */
export const DRAWER_BREAKPOINT = `${String(DESKTOP_MINIMUM_WIDTH - 0.02)}px`;

/** The viewports that show the navigation drawer. */
export const DRAWER_QUERY = `(max-width: ${DRAWER_BREAKPOINT})`;

/** The viewports that also show the bottom tab bar. */
export const PHONE_TAB_QUERY = `(max-width: ${String(PHONE_TAB_LIMIT - 0.02)}px)`;

/** Which form the navigation takes. */
export type ShellNavigationMode = 'expanded' | 'drawer';

/** The shell's navigation form and whether its drawer is open. */
export class ShellNavigation {
  readonly #preferences: LayoutPreferences;
  readonly #drawer = new MediaQuery(DRAWER_QUERY, false);
  readonly #phoneTabs = new MediaQuery(PHONE_TAB_QUERY, false);

  /** Whether the navigation drawer is open. It starts closed on every page load. */
  drawerOpen = $state(false);
  constructor(preferences: LayoutPreferences) {
    this.#preferences = preferences;
  }

  /** The form the navigation takes at this width. */
  get mode(): ShellNavigationMode {
    return this.#drawer.current ? 'drawer' : 'expanded';
  }

  get showPhoneTabs(): boolean {
    return this.#phoneTabs.current;
  }

  /**
   * Whether the sidebar is drawn as its icon rail, or, as a drawer, closed: the value Cinder's
   * `Sidebar` binds. Desktop stores the preference. On a tablet or phone it controls the drawer.
   */
  get collapsed(): boolean {
    return this.mode === 'drawer' ? !this.drawerOpen : this.#preferences.sidebarCollapsed;
  }

  set collapsed(collapsed: boolean) {
    if (this.mode === 'drawer') this.drawerOpen = !collapsed;
    else this.#preferences.setSidebarCollapsed(collapsed);
  }

  /** Closes the drawer when a destination opens. */
  close(): void {
    this.drawerOpen = false;
  }
}

const SHELL_NAVIGATION_KEY = Symbol('shell-navigation');

/** Makes the shell's navigation state available to the sidebar and the top bar. */
export function provideShellNavigation(navigation: ShellNavigation): ShellNavigation {
  setContext(SHELL_NAVIGATION_KEY, navigation);
  return navigation;
}

/** The shell's navigation state, or `undefined` under a component mounted without the shell. */
export function getShellNavigation(): ShellNavigation | undefined {
  return getContext<ShellNavigation | undefined>(SHELL_NAVIGATION_KEY);
}
