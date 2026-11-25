/**
 * Desktop docks the sidebar, smaller windows use the drawer, and phones add bottom tabs.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { LayoutPreferences } from '../layout-preferences.svelte.ts';
import {
  DESKTOP_MINIMUM_WIDTH,
  DRAWER_BREAKPOINT,
  DRAWER_QUERY,
  PHONE_TAB_QUERY,
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
  test('uses the existing drawer for tablet navigation and preserves the desktop preference', () => {
    viewport([DRAWER_QUERY]);
    const { shell, preferences } = navigation();
    preferences.setSidebarCollapsed(false);
    expect(shell.mode).toBe('drawer');
    expect(shell.showPhoneTabs).toBe(false);
    expect(shell.collapsed).toBe(true);
    shell.collapsed = false;
    expect(shell.drawerOpen).toBe(true);
    shell.close();
    expect(shell.drawerOpen).toBe(false);
    expect(preferences.sidebarCollapsed).toBe(false);
  });

  test('is the column at 1200px and wider, and follows the person’s preference there', () => {
    viewport([]);
    const { shell, preferences } = navigation();
    expect(shell.mode).toBe('expanded');
    expect(shell.collapsed).toBe(false);
    shell.collapsed = true;
    expect(preferences.sidebarCollapsed).toBe(true);
    expect(window.localStorage.getItem('interborough-sidebar-collapsed')).toBe('true');
  });

  test('is the drawer under 700px, closed until opened, and never writes the preference', () => {
    viewport([DRAWER_QUERY, PHONE_TAB_QUERY]);
    const { shell, preferences } = navigation();
    expect(shell.mode).toBe('drawer');
    expect(shell.showPhoneTabs).toBe(true);
    expect(shell.collapsed).toBe(true);
    shell.collapsed = false;
    expect(shell.drawerOpen).toBe(true);
    expect(shell.collapsed).toBe(false);
    expect(preferences.sidebarCollapsed).toBe(false);
    shell.close();
    expect(shell.drawerOpen).toBe(false);
  });

  test('uses 1200px for desktop and 700px for the tab bar', () => {
    expect(DESKTOP_MINIMUM_WIDTH).toBe(1200);
    expect(DRAWER_BREAKPOINT).toBe('1199.98px');
    expect(DRAWER_QUERY).toBe('(max-width: 1199.98px)');
    expect(PHONE_TAB_QUERY).toBe('(max-width: 699.98px)');
  });
});
