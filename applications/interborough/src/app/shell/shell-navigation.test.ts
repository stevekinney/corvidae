/**
 * How the shell shows its navigation (design rows 04a to 04c, COR-2315): the column at 1200px and
 * wider, the 76px rail from 700px to 1199px, and the drawer behind the bottom tab bar under 700px.
 * The person's own preference applies only to the column.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { LayoutPreferences } from '../layout-preferences.svelte.ts';
import {
  DESKTOP_MINIMUM_WIDTH,
  DRAWER_BREAKPOINT,
  DRAWER_QUERY,
  EXPANDED_QUERY,
  RAIL_MINIMUM_WIDTH,
  ShellNavigation,
} from './shell-navigation.svelte.ts';

const undo: Array<() => void> = [];
afterEach(() => {
  for (const restore of undo.splice(0).reverse()) restore();
  window.localStorage.clear();
});

/** A viewport that answers `matchMedia` with the queries `matching` lists. */
function viewport(matching: readonly string[]): void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: matching.some((entry) => query === entry),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
  undo.push(() => {
    window.matchMedia = original;
  });
}

function navigation(): { shell: ShellNavigation; preferences: LayoutPreferences } {
  const preferences = new LayoutPreferences(window.localStorage);
  return { shell: new ShellNavigation(preferences), preferences };
}

describe('the shell navigation', () => {
  test('is the column at 1200px and wider, and follows the person’s preference there', () => {
    viewport([EXPANDED_QUERY]);
    const { shell, preferences } = navigation();
    expect(shell.mode).toBe('expanded');
    expect(shell.collapsed).toBe(false);
    shell.collapsed = true;
    expect(preferences.sidebarCollapsed).toBe(true);
    expect(window.localStorage.getItem('interborough-sidebar-collapsed')).toBe('true');
  });

  test('is the rail on a tablet, whatever the preference says (04b)', () => {
    viewport([]);
    const { shell, preferences } = navigation();
    preferences.setSidebarCollapsed(false);
    expect(shell.mode).toBe('rail');
    expect(shell.collapsed).toBe(true);
    // Expanding opens the overlay and never writes the preference.
    shell.collapsed = false;
    expect(shell.overlayOpen).toBe(true);
    expect(shell.collapsed).toBe(false);
    expect(preferences.sidebarCollapsed).toBe(false);
    shell.close();
    expect(shell.overlayOpen).toBe(false);
    expect(shell.collapsed).toBe(true);
  });

  test('is the drawer under 700px, closed until opened, and never writes the preference', () => {
    viewport([DRAWER_QUERY]);
    const { shell, preferences } = navigation();
    expect(shell.mode).toBe('drawer');
    expect(shell.collapsed).toBe(true);
    shell.collapsed = false;
    expect(shell.drawerOpen).toBe(true);
    expect(shell.collapsed).toBe(false);
    expect(preferences.sidebarCollapsed).toBe(false);
    shell.close();
    expect(shell.drawerOpen).toBe(false);
  });

  test('draws its breakpoints at 1200px and 700px (COR-2315)', () => {
    expect(DESKTOP_MINIMUM_WIDTH).toBe(1200);
    expect(RAIL_MINIMUM_WIDTH).toBe(700);
    expect(EXPANDED_QUERY).toBe('(min-width: 1200px)');
    expect(DRAWER_QUERY).toBe('(max-width: 699.98px)');
    expect(DRAWER_BREAKPOINT).toBe('699.98px');
  });

  test('gives touch no form of its own: a tablet gets the rail, whose labels are drawn', () => {
    // Only the width decides. A pointer-based drawer query would hide the rail on a touch tablet,
    // where the rail now draws its labels and needs no tooltip.
    expect(DRAWER_QUERY).not.toContain('pointer');
    viewport([]);
    expect(navigation().shell.mode).toBe('rail');
  });

  test('a viewport that matches both queries is a phone first', () => {
    viewport([DRAWER_QUERY, EXPANDED_QUERY]);
    expect(navigation().shell.mode).toBe('drawer');
  });
});
