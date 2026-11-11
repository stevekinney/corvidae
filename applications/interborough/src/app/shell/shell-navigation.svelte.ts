/**
 * How the shell shows its navigation (design rows 04a to 04c, COR-2315), which is a choice of three
 * forms:
 *
 * - `expanded`: at 1200px and wider the sidebar is in the page, 190px wide, or folded to its 56px
 *   icon rail when the person chose that in quick settings (the only place that choice applies).
 * - `rail`: from 700px to 1199px the sidebar is the 76px rail, an icon over a short label for
 *   every destination, whatever the preference says and whatever the pointer. Expanding it opens
 *   the full sidebar as an overlay over the page, which closes on navigation.
 * - `drawer`: under 700px there is no sidebar. The shell shows a bottom tab bar (`./tab-bar.svelte`)
 *   for the places a thumb goes most, and the tab bar's More tab and the top bar's menu button open
 *   the full navigation as a 280px drawer. The rail's labels are drawn, not tooltips, so touch
 *   needs no form of its own: a tablet gets the rail.
 *
 * One object owns the three, so the sidebar, the top bar, the tab bar and the shell agree about
 * which one is on screen and about what "collapsed" means in each.
 */
import { getContext, setContext } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';

import type { LayoutPreferences } from '../layout-preferences.svelte.ts';

/** The viewport width at and above which the sidebar stays in the page, in CSS pixels. */
export const DESKTOP_MINIMUM_WIDTH = 1200;

/** The viewport width at and above which the sidebar is the rail rather than the drawer. */
export const RAIL_MINIMUM_WIDTH = 700;

/** The widest viewport that shows the drawer and the tab bar, as a CSS length for `Sidebar`. */
export const DRAWER_BREAKPOINT = `${String(RAIL_MINIMUM_WIDTH - 0.02)}px`;

/** The viewports that show the tab bar and the navigation drawer: phones. */
export const DRAWER_QUERY = `(max-width: ${DRAWER_BREAKPOINT})`;

/** The viewports wide enough for the sidebar to stay in the page. */
export const EXPANDED_QUERY = `(min-width: ${String(DESKTOP_MINIMUM_WIDTH)}px)`;

/** Which of the three forms the navigation takes. */
export type ShellNavigationMode = 'expanded' | 'rail' | 'drawer';

/** The shell's navigation form, and whether its drawer or overlay is open. */
export class ShellNavigation {
  readonly #preferences: LayoutPreferences;
  readonly #drawer = new MediaQuery(DRAWER_QUERY, false);
  readonly #expanded = new MediaQuery(EXPANDED_QUERY, true);

  /** Whether the navigation drawer is open. It starts closed on every page load. */
  drawerOpen = $state(false);
  /** Whether the rail has been expanded to the full sidebar over the page. */
  overlayOpen = $state(false);

  constructor(preferences: LayoutPreferences) {
    this.#preferences = preferences;
  }

  /** The form the navigation takes at this viewport and pointer. */
  get mode(): ShellNavigationMode {
    if (this.#drawer.current) return 'drawer';
    return this.#expanded.current ? 'expanded' : 'rail';
  }

  /**
   * Whether the sidebar is drawn as its icon rail, or, as a drawer, closed: the value Cinder's
   * `Sidebar` binds. Setting it writes the person's preference on a wide viewport only; on a tablet
   * and a phone it opens and closes the overlay and the drawer.
   */
  get collapsed(): boolean {
    switch (this.mode) {
      case 'drawer':
        return !this.drawerOpen;
      case 'rail':
        return !this.overlayOpen;
      case 'expanded':
        return this.#preferences.sidebarCollapsed;
    }
  }

  set collapsed(collapsed: boolean) {
    switch (this.mode) {
      case 'drawer':
        this.drawerOpen = !collapsed;
        break;
      case 'rail':
        this.overlayOpen = !collapsed;
        break;
      case 'expanded':
        this.#preferences.setSidebarCollapsed(collapsed);
        break;
    }
  }

  /** Closes the drawer and the overlay, as a navigation does. The preference is never touched. */
  close(): void {
    this.drawerOpen = false;
    this.overlayOpen = false;
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
