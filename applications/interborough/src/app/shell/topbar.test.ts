/**
 * The top bar (design rows 03l, 04e, 14f): the menu button only while the navigation is a drawer,
 * the breadcrumb naming the page in words, the field that opens the palette, which says "Search
 * everything" and nothing more, then the notifications bell and quick settings.
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../../lib/router.svelte.ts';
import { LayoutPreferences } from '../layout-preferences.svelte.ts';
import { memoryStore } from '../notification-store.test-support.ts';
import { ThemeStore } from '../theme.svelte.ts';
import { DRAWER_QUERY, EXPANDED_QUERY, ShellNavigation } from './shell-navigation.svelte.ts';
import Harness from './topbar.test-harness.svelte';

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
  const layout = new LayoutPreferences(window.localStorage);
  const navigation = new ShellNavigation(layout);
  const notifications = memoryStore();
  const view = render(Harness, {
    props: {
      navigation,
      notifications,
      theme: new ThemeStore(document.documentElement, window.localStorage),
      layout,
    },
  });
  return { ...view, navigation, notifications };
}

describe('the top bar', () => {
  test('draws no menu button where the sidebar stays in the page or is a rail', () => {
    for (const matching of [[EXPANDED_QUERY], []]) {
      viewport(matching);
      landAt('/health');
      const { queryByRole, unmount } = mount();
      expect(queryByRole('button', { name: 'Open navigation' })).toBeNull();
      unmount();
    }
  });

  test('draws the menu button first while the navigation is a drawer, and it opens the drawer', async () => {
    viewport([DRAWER_QUERY]);
    landAt('/health');
    const { getByRole, navigation, container } = mount();
    const button = getByRole('button', { name: 'Open navigation' });
    expect(container.querySelector('header')?.firstElementChild).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(button);
    expect(navigation.drawerOpen).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  test('marks a page below a top-level one, whose back link takes the menu button’s place on a phone (06m)', () => {
    viewport([DRAWER_QUERY]);
    for (const [path, nested] of [
      ['/health', false],
      ['/chats/sample-chat', true],
    ] as const) {
      landAt(path);
      const { container, unmount } = mount();
      expect(container.querySelector('header')?.hasAttribute('data-nested'), path).toBe(nested);
      unmount();
    }
  });

  test('the bar keeps its surface and its rule in every mode (COR-2445)', async () => {
    for (const matching of [[DRAWER_QUERY], [EXPANDED_QUERY]]) {
      viewport(matching);
      landAt('/health');
      const { container, unmount } = mount();
      const header = container.querySelector('header');
      expect(header?.classList.contains('cinder-translucent-surface')).toBe(false);
      unmount();
    }
    const css = await Bun.file(new URL('../../styles/foundation.css', import.meta.url)).text();
    expect(css).toMatch(/\.weft-shell-topbar \{[^}]*border-bottom:[^}]*background:/);
  });

  test('the phone controls are the Buttons own faces a step apart, with no sized layout box (COR-2445)', async () => {
    const css = await Bun.file(new URL('../../styles/foundation.css', import.meta.url)).text();
    const phone = css.match(/@media \(max-width: 639\.98px\) \{[\s\S]*?\n\}\n/)?.[0] ?? '';
    expect(phone).toMatch(/\.weft-shell-topbar \{\s*gap: var\(--cinder-space-1\);/);
    expect(phone).not.toMatch(/(block-size|min-inline-size|inline-size|min-width): (40|44)px/);
    // The search trigger is as wide as the Button's face is tall. Never an aspect ratio: the wide
    // rule gives the trigger 300px of width, which a 1:1 ratio turned into a 300px-tall control.
    expect(phone).toMatch(
      /\.weft-shell-search-trigger \{\s*flex: none;\s*inline-size: var\(--cinder-button-height-md\);/,
    );
    expect(phone).not.toContain('aspect-ratio');
  });

  test('names the page in words in the breadcrumb, and Home at the root', () => {
    viewport([EXPANDED_QUERY]);
    for (const [path, name] of [
      ['/health', 'Health'],
      ['/', 'Home'],
    ] as const) {
      landAt(path);
      const { getByRole, unmount } = mount();
      const trail = getByRole('navigation', { name: 'Breadcrumb' });
      expect(trail.textContent?.trim(), path).toBe(name);
      unmount();
    }
  });

  test('the search field says "Search everything" with a ⌘K hint, and opens the palette', async () => {
    viewport([EXPANDED_QUERY]);
    landAt('/');
    const { getByRole, getByTestId } = mount();
    const search = getByRole('button', { name: /^Search everything/ });
    expect(search.querySelector('.weft-shell-search-trigger__label')?.textContent).toBe(
      'Search everything',
    );
    expect(search.querySelector('.weft-shell-search-trigger__kbd')?.textContent?.trim()).toBe('⌘K');
    await fireEvent.click(search);
    expect(getByTestId('palette-open').textContent).toBe('true');
  });

  test('ends with the search field, the bell and quick settings, in that order', () => {
    viewport([EXPANDED_QUERY]);
    landAt('/');
    const { container } = mount();

    const controls = Array.from(container.querySelectorAll('header button')).map(
      (control) => control.getAttribute('aria-label') ?? control.textContent?.trim().slice(0, 17),
    );
    expect(controls).toEqual(['Search everything', 'Notifications', 'Quick settings']);
  });

  test('the bell carries a dot while anything is unread, and says how many in its name', () => {
    viewport([EXPANDED_QUERY]);
    landAt('/');
    const { getByRole, container, notifications } = mount();
    expect(container.querySelector('.weft-notification-bell__dot')).toBeNull();

    notifications.setActivity([
      {
        id: 'review:one',
        kind: 'approval',
        tier: 'warning',
        icon: 'shield-question-mark',
        title: 'Refund order 4471 for $42.00?',
        detail: 'Waiting for your approval, Tool runner',
        href: '/reviews',
        emittedAtMs: Date.now() - 240_000,
      },
    ]);

    return waitFor(() => {
      expect(getByRole('button', { name: 'Notifications: 1 unread' })).not.toBeNull();
      expect(container.querySelector('.weft-notification-bell__dot')).not.toBeNull();
    });
  });
});
