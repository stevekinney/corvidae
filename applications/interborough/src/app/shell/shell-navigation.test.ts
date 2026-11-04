/**
 * How the shell shows its navigation (design rows 04a to 04c): the column at 1024px and wider, the
 * rail from 640px with a fine pointer, and the drawer under 640px and for touch below 1024px. The
 * person's own preference applies only to the column.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { LayoutPreferences } from '../layout-preferences.svelte.ts';
import {
  DRAWER_QUERY,
  EXPANDED_QUERY,
  ShellNavigation,
  TOUCH_DRAWER_QUERY,
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
  test('is the column at 1024px and wider, and follows the person’s preference there', () => {
    viewport([EXPANDED_QUERY]);
    const { shell, preferences } = navigation();
    expect(shell.mode).toBe('expanded');
    expect(shell.collapsed).toBe(false);
    shell.collapsed = true;
    expect(preferences.sidebarCollapsed).toBe(true);
    expect(window.localStorage.getItem('interborough-sidebar-collapsed')).toBe('true');
  });

  test('is the rail on a tablet with a fine pointer, whatever the preference says (04b)', () => {
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

  test('is the drawer under 640px, closed until opened, and never writes the preference', () => {
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

  test('is the drawer for touch below 1024px, because a rail has no labels on touch (04c)', () => {
    expect(TOUCH_DRAWER_QUERY).toContain('(pointer: coarse)');
    expect(TOUCH_DRAWER_QUERY).toContain('max-width: 1023.98px');
    expect(DRAWER_QUERY).toContain(TOUCH_DRAWER_QUERY);
    viewport([DRAWER_QUERY, EXPANDED_QUERY]);
    // A viewport that matches both is a touch device and a drawer first.
    expect(navigation().shell.mode).toBe('drawer');
  });
});
