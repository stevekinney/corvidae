/**
 * The phone's bottom tab bar (COR-2315): four destinations and a More tab under 700px, each an icon
 * over its label, the current one marked, and nothing drawn at any other width.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../../lib/router.svelte.ts';
import { LayoutPreferences } from '../layout-preferences.svelte.ts';
import { TAB_BAR_VIEWS } from './destinations.ts';
import { DRAWER_QUERY, EXPANDED_QUERY, ShellNavigation } from './shell-navigation.svelte.ts';
import Harness from './tab-bar.test-harness.svelte';

const undo: Array<() => void> = [];
afterEach(() => {
  for (const restore of undo.splice(0).reverse()) restore();
  window.localStorage.clear();
});

function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

function viewport(matching: readonly string[]): void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: matching.includes(query),
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

function mount() {
  const navigation = new ShellNavigation(new LayoutPreferences(window.localStorage));
  const view = render(Harness, { props: { navigation } });
  return { ...view, navigation };
}

describe('the tab bar', () => {
  test('is drawn on a phone only, and draws nothing on a tablet or a desktop', () => {
    for (const matching of [[EXPANDED_QUERY], []]) {
      viewport(matching);
      landAt('/');
      const { queryByRole, unmount } = mount();
      expect(queryByRole('navigation', { name: 'Main tabs' })).toBeNull();
      unmount();
    }
    viewport([DRAWER_QUERY]);
    landAt('/');
    const { getByRole } = mount();
    expect(getByRole('navigation', { name: 'Main tabs' })).not.toBeNull();
  });

  test('is Cinder’s bottom bar, with Home, Chat, Reviews and Runs, then More', () => {
    viewport([DRAWER_QUERY]);
    landAt('/');
    const { getByRole } = mount();
    const bar = getByRole('navigation', { name: 'Main tabs' });
    expect(bar.getAttribute('data-cinder-placement')).toBe('bottom');
    expect(bar.classList.contains('weft-shell-tab-bar')).toBe(true);
    expect(TAB_BAR_VIEWS).toEqual(['home', 'chat', 'reviews', 'runs']);
    const tabs = Array.from(bar.querySelectorAll('.cinder-navigation-item'));
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      'Home',
      'Chat',
      'Reviews',
      'Runs',
      'More',
    ]);
    expect(tabs.slice(0, 4).map((tab) => tab.getAttribute('href'))).toEqual([
      '/',
      '/chats',
      '/reviews',
      '/runs',
    ]);
  });

  test('draws an icon over every label, hidden from assistive technology', () => {
    viewport([DRAWER_QUERY]);
    landAt('/');
    const { getByRole } = mount();
    const bar = getByRole('navigation', { name: 'Main tabs' });
    for (const tab of Array.from(bar.querySelectorAll('.cinder-navigation-item'))) {
      const icon = tab.querySelector('.cinder-navigation-item__icon');
      expect(icon?.getAttribute('aria-hidden'), tab.textContent ?? '').toBe('true');
      expect(icon?.querySelector('svg')).not.toBeNull();
      expect(tab.querySelector('[data-cinder-navigation-label]')).not.toBeNull();
    }
  });

  test('marks the tab for the page on screen, Chat on a session and Home at the root alone', () => {
    viewport([DRAWER_QUERY]);
    const cases = [
      ['/', 'Home'],
      ['/chats/session-1', 'Chat'],
      ['/runs/run-1', 'Runs'],
    ] as const;
    for (const [path, current] of cases) {
      landAt(path);
      const { getByRole, unmount } = mount();
      const bar = getByRole('navigation', { name: 'Main tabs' });
      const marked = Array.from(bar.querySelectorAll('[aria-current="page"]')).map((tab) =>
        tab.textContent?.trim(),
      );
      expect(marked, path).toEqual([current]);
      unmount();
    }
  });

  test('marks no tab for a page the bar does not hold', () => {
    viewport([DRAWER_QUERY]);
    landAt('/health');
    const { getByRole } = mount();
    const bar = getByRole('navigation', { name: 'Main tabs' });
    expect(bar.querySelector('[aria-current]')).toBeNull();
  });

  test('a tab opens its page without leaving the application', async () => {
    viewport([DRAWER_QUERY]);
    landAt('/');
    const { getByRole, navigation } = mount();
    navigation.drawerOpen = true;
    await fireEvent.click(getByRole('link', { name: 'Runs' }));
    expect(router.pathname).toBe('/runs');
    // A navigation closes the drawer, as it does from the sidebar.
    expect(navigation.drawerOpen).toBe(false);
  });

  test('the More tab opens the navigation drawer and says it is open', async () => {
    viewport([DRAWER_QUERY]);
    landAt('/');
    const { getByRole, navigation } = mount();
    const more = getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-haspopup')).toBe('dialog');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(more);
    expect(navigation.drawerOpen).toBe(true);
    expect(more.getAttribute('aria-expanded')).toBe('true');
  });
});
