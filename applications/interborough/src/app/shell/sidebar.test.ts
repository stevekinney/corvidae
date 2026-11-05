/**
 * The sidebar (design rows 03a to 03m, 04a to 04c, 05r, 07h, 07k): the product's name as text, Home
 * on its own, then Work, Build and System with Settings last; Reviews carrying the reviews waiting
 * on the person, Health a dot that follows what needs attention; and the three forms it takes, the
 * column, the rail with its overlay, and the drawer.
 */
import { HttpClient } from '@lostgradient/weft';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES, type AuthorizationScope } from '../../lib/scopes.svelte.ts';
import { LayoutPreferences } from '../layout-preferences.svelte.ts';
import { ShellNavigation } from './shell-navigation.svelte.ts';
import Harness from './sidebar.test-harness.svelte';

let restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
  asked = [];
  window.localStorage.clear();
});

/** Gives happy-dom's `about:blank` window a real origin, so `pushState` takes effect, at `path`. */
function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

/** The Bureau methods the stub has been asked, in order, until the test ends. */
let asked: string[] = [];

/** What the Bureau answers `bureau.health.attention` with: a count, or a refusal. */
type Attention = number | 'refused';

function stubEngine(
  options: { bureauReviews?: number; attention?: Attention; pendingReviews?: number } = {},
): void {
  restore.push(
    installFetchImplementation(async (input, init) => {
      const text =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(text, 'http://localhost');
      if (url.pathname.endsWith('/reviews')) {
        const items = Array.from({ length: options.pendingReviews ?? 0 }, (_, index) => ({
          status: 'pending',
          reviewId: `review-${index}`,
          workflowId: `wf-${index}`,
          artifact: {},
          reviewType: 'content',
          reviewers: [],
          allowPartial: false,
          createdAt: Date.now(),
        }));
        return Response.json({ items });
      }
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as { id?: unknown; method?: unknown })
          : {};
      if (typeof body.method === 'string') asked.push(body.method);
      if (body.method === 'bureau.health.attention') {
        if (options.attention === 'refused') {
          return Response.json(
            {
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32001, message: 'Forbidden', data: { httpStatus: 403 } },
            },
            { status: 403 },
          );
        }
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { items: [], count: options.attention ?? 0, checks: [] },
        });
      }
      // The Bureau's own pending reviews, which the Reviews count adds to the engine's.
      const reviews = Array.from({ length: options.bureauReviews ?? 0 }, (_, index) => ({
        ...toolApprovalFixture({ id: `bureau-review-${index}`, runId: `run-${index}` }),
      }));
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { reviews } });
    }),
  );
}

/** Answers `matchMedia` for the queries `matching` accepts, until the test ends. */
function matchMediaWhere(matching: (query: string) => boolean): void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: matching(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
  restore.push(() => {
    window.matchMedia = original;
  });
}

/** A viewport at least 1024px wide, where the sidebar stays in the page. */
function onDesktop(): void {
  matchMediaWhere((query) => query.includes('min-width: 1024px'));
}

/** A tablet with a fine pointer: under 1024px and over 640px, so the rail. */
function onTablet(): void {
  matchMediaWhere(() => false);
}

/** A phone, or a touch tablet: the drawer. */
function onPhone(): void {
  matchMediaWhere((query) => query.includes('max-width'));
}

function mount(
  options: {
    scopes?: readonly AuthorizationScope[];
    navigation?: ShellNavigation;
  } = {},
) {
  return render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      ...(options.scopes === undefined ? {} : { scopes: options.scopes }),
      ...(options.navigation === undefined ? {} : { navigation: options.navigation }),
    },
  });
}

/** The shell's navigation state over fresh preferences. */
function navigationState(): ShellNavigation {
  return new ShellNavigation(new LayoutPreferences(window.localStorage));
}

const ROW_LABELS = [
  'Home',
  'Chat',
  'Reviews',
  'Runs',
  'Agents',
  'Workflows',
  'Schedules',
  'Goals',
  'Capabilities',
  'Hooks',
  'Health',
  'Settings',
];

/** The text a row's name starts with, which is its label whatever count or dot follows. */
function labelOf(link: Element): string | undefined {
  return (link.getAttribute('aria-label') ?? link.textContent ?? '').trim().split(/,|\s{2,}/)[0];
}

describe('the sidebar', () => {
  test('names the product as text only, with an icon-only collapse button beside it (03h)', () => {
    onDesktop();
    stubEngine();
    landAt('/chats');
    const { getByRole, container } = mount();

    const name = container.querySelector('.weft-shell-sidebar__name');
    expect(name?.textContent).toBe('Interborough');
    expect(name?.querySelector('svg, img')).toBeNull();
    const collapse = getByRole('button', { name: 'Collapse sidebar' });
    expect(collapse.textContent?.trim()).toBe('');
    expect(collapse.querySelector('svg')).not.toBeNull();
    expect(name?.parentElement).toBe(collapse.parentElement);
  });

  test('holds Home, then Work, Build and System in order, System pinned last (03h)', () => {
    onDesktop();
    stubEngine();
    landAt('/chats');
    const { getByRole } = mount();

    const navigation = getByRole('navigation', { name: 'Views' });
    const links = Array.from(navigation.querySelectorAll('a')).map(labelOf);
    expect(links).toEqual(ROW_LABELS);

    const groups = Array.from(navigation.querySelectorAll('.cinder-side-navigation-group'));
    expect(
      groups.map(
        (group) => group.querySelector('.cinder-side-navigation-group__heading')?.textContent,
      ),
    ).toEqual(['Work', 'Build', 'System']);
    // Every section is a static label over its rows, not a control that folds.
    expect(navigation.querySelectorAll('.cinder-side-navigation-group__trigger').length).toBe(0);
    expect(groups.map((group) => Array.from(group.querySelectorAll('a')).map(labelOf))).toEqual([
      ['Chat', 'Reviews', 'Runs'],
      ['Agents', 'Workflows', 'Schedules', 'Goals', 'Capabilities', 'Hooks'],
      ['Health', 'Settings'],
    ]);
    // Home sits above the sections, and System is the one pushed to the bottom of the column.
    const first = navigation.querySelector('a');
    expect(first && groups[0]?.contains(first)).toBe(false);
    expect(groups.map((group) => group.classList.contains('weft-shell-nav-system'))).toEqual([
      false,
      false,
      true,
    ]);
  });

  test('links each row to its route', () => {
    onDesktop();
    stubEngine();
    landAt('/chats');
    const { getByRole } = mount();
    const navigation = getByRole('navigation', { name: 'Views' });
    const paths = Object.fromEntries(
      Array.from(navigation.querySelectorAll('a')).map((link) => [
        labelOf(link),
        link.getAttribute('href'),
      ]),
    );
    expect(paths).toEqual({
      Home: '/',
      Chat: '/chats',
      Reviews: '/reviews',
      Runs: '/runs',
      Agents: '/agents',
      Workflows: '/workflows',
      Schedules: '/schedules',
      Goals: '/goals',
      Capabilities: '/capabilities',
      Hooks: '/hooks',
      Health: '/health',
      Settings: '/settings',
    });
  });

  test('marks Home current at the root only, and Chat on a session (03i)', () => {
    onDesktop();
    stubEngine();
    const cases = [
      ['/', 'Home'],
      ['/chats', 'Chat'],
      ['/chats/session-1', 'Chat'],
      ['/runs/run-1', 'Runs'],
      ['/health/storage', 'Health'],
    ] as const;
    for (const [path, current] of cases) {
      landAt(path);
      const { getByRole, unmount } = mount();
      const navigation = getByRole('navigation', { name: 'Views' });
      const marked = Array.from(navigation.querySelectorAll('a[aria-current="page"]')).map(labelOf);
      expect(marked, path).toEqual([current]);
      unmount();
    }
  });

  test('Settings wears the gear, and the sliders icon stays with quick settings (W50)', () => {
    onDesktop();
    stubEngine();
    landAt('/chats');
    const { getByRole } = mount();
    const settings = getByRole('link', { name: /^Settings/ });
    expect(settings.querySelector('svg')?.getAttribute('class')).toContain('lucide-settings');
    expect(settings.querySelector('svg')?.getAttribute('class')).not.toContain('sliders');
  });

  test('navigates without leaving the page', async () => {
    onDesktop();
    stubEngine();
    landAt('/chats');
    const { getByRole } = mount();
    await fireEvent.click(getByRole('link', { name: /^Runs/ }));
    expect(router.pathname).toBe('/runs');
  });

  test('Reviews shows the reviews waiting on the person, and the count is one number (03j)', async () => {
    onDesktop();
    stubEngine({ bureauReviews: 2, pendingReviews: 1 });
    landAt('/chats');
    const { getByRole } = mount();
    await waitFor(() => expect(getByRole('link', { name: 'Reviews, 3 need you' })).not.toBeNull());
  });

  test('Reviews counts the Bureau’s alone when the principal does not hold reviews:read', async () => {
    onDesktop();
    stubEngine({ bureauReviews: 2, pendingReviews: 3 });
    landAt('/chats');
    const { getByRole } = mount({
      scopes: AUTHORIZATION_SCOPES.filter((scope) => scope !== 'reviews:read'),
    });
    await waitFor(() => expect(getByRole('link', { name: 'Reviews, 2 need you' })).not.toBeNull());
  });

  test('Reviews shows no count at zero, and never counts a system problem (03j)', async () => {
    onDesktop();
    stubEngine({ attention: 3 });
    landAt('/chats');
    const { getByRole, container } = mount();
    // Wait for the attention answer to land, which is the Health dot turning amber.
    await waitFor(() =>
      expect(getByRole('link', { name: 'Health, 3 need attention' })).not.toBeNull(),
    );
    const reviews = getByRole('link', { name: /^Reviews/ });
    expect(reviews.getAttribute('aria-label') ?? reviews.textContent?.trim()).toBe('Reviews');
    expect(container.querySelector('a[href="/reviews"] .cinder-badge')).toBeNull();
  });

  test('Health’s dot is amber while anything needs attention, and its name says how many (03k)', async () => {
    onDesktop();
    stubEngine({ attention: 3 });
    landAt('/chats');
    const { getByRole } = mount();
    const health = await waitFor(() => getByRole('link', { name: 'Health, 3 need attention' }));
    const wrapper = health.querySelector('.cinder-side-navigation-item__dot');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('.cinder-status-dot')?.getAttribute('data-cinder-status')).toBe(
      'warning',
    );
    // The dot is decoration over the name, so assistive technology never reads it twice.
    expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
    // The count names the row and is not drawn as a number beside the dot.
    expect(health.querySelector('.cinder-badge')).toBeNull();
  });

  test('Health’s dot is green, and the name says so, when nothing needs attention (03k)', async () => {
    onDesktop();
    stubEngine({ attention: 0 });
    landAt('/chats');
    const { getByRole } = mount();
    const health = await waitFor(() =>
      getByRole('link', { name: 'Health, nothing needs attention' }),
    );
    expect(health.querySelector('.cinder-status-dot')?.getAttribute('data-cinder-status')).toBe(
      'success',
    );
  });

  test('Health leaves the dot out when the count is refused, rather than claim all is well', async () => {
    onDesktop();
    stubEngine({ attention: 'refused', bureauReviews: 1 });
    landAt('/chats');
    const { getByRole } = mount();
    // The Reviews row answering, and the attention count asked for, mean both queries have run.
    await waitFor(() => expect(getByRole('link', { name: 'Reviews, 1 need you' })).not.toBeNull());
    await waitFor(() => expect(asked.includes('bureau.health.attention')).toBe(true));
    const health = getByRole('link', { name: 'Health' });
    expect(health.querySelector('.cinder-status-dot')).toBeNull();
    expect(health.getAttribute('aria-label')).toBeNull();
  });

  test('folds to its icon rail from its header, and opens again (03a)', async () => {
    onDesktop();
    stubEngine();
    landAt('/chats');
    const { getByRole } = mount();
    await fireEvent.click(getByRole('button', { name: 'Collapse sidebar' }));
    expect(document.querySelector('.weft-shell-sidebar--collapsed')).not.toBeNull();
    const expand = getByRole('button', { name: 'Expand sidebar' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(window.localStorage.getItem('interborough-sidebar-collapsed')).toBe('true');
    await fireEvent.click(expand);
    expect(document.querySelector('.weft-shell-sidebar--collapsed')).toBeNull();
    expect(window.localStorage.getItem('interborough-sidebar-collapsed')).toBe('false');
  });

  test('on the rail a row’s name still carries its count, and the rail keeps Reviews and Health (03a)', async () => {
    onDesktop();
    stubEngine({ bureauReviews: 2, attention: 3 });
    window.localStorage.setItem('interborough-sidebar-collapsed', 'true');
    landAt('/chats');
    const { getByRole } = mount();
    expect(document.querySelector('.weft-shell-sidebar--collapsed')).not.toBeNull();
    await waitFor(() => expect(getByRole('link', { name: 'Reviews, 2 need you' })).not.toBeNull());
    await waitFor(() =>
      expect(getByRole('link', { name: 'Health, 3 need attention' })).not.toBeNull(),
    );
    expect(getByRole('button', { name: 'Expand sidebar' })).not.toBeNull();
  });
});

describe('the sidebar on a tablet with a fine pointer (04a)', () => {
  test('is the 56px rail whatever the preference says, and the preference is left alone', () => {
    onTablet();
    stubEngine();
    landAt('/chats');
    const navigation = navigationState();
    const { container } = mount({ navigation });
    expect(navigation.mode).toBe('rail');
    expect(container.querySelector('.weft-shell-sidebar--rail')).not.toBeNull();
    expect(container.querySelector('.weft-shell-sidebar--collapsed')).not.toBeNull();
    expect(container.querySelector('.weft-shell-sidebar-slot')?.getAttribute('data-mode')).toBe(
      'rail',
    );
  });

  test('expanding opens the full sidebar as an overlay that closes on navigation', async () => {
    onTablet();
    stubEngine();
    landAt('/chats');
    const navigation = navigationState();
    const { getByRole, container } = mount({ navigation });
    await fireEvent.click(getByRole('button', { name: 'Expand sidebar' }));
    expect(container.querySelector('.weft-shell-sidebar--overlay')).not.toBeNull();
    expect(container.querySelector('.weft-shell-sidebar--collapsed')).toBeNull();
    expect(container.querySelector('.weft-shell-sidebar-scrim')).not.toBeNull();
    // Opening the overlay never writes the person's own preference.
    expect(window.localStorage.getItem('interborough-sidebar-collapsed')).toBeNull();

    await fireEvent.click(getByRole('link', { name: /^Runs/ }));
    expect(router.pathname).toBe('/runs');
    expect(container.querySelector('.weft-shell-sidebar--overlay')).toBeNull();
    expect(container.querySelector('.weft-shell-sidebar--collapsed')).not.toBeNull();
  });

  test('Escape and the scrim close the overlay', async () => {
    onTablet();
    stubEngine();
    landAt('/chats');
    const navigation = navigationState();
    const { getByRole, container } = mount({ navigation });
    await fireEvent.click(getByRole('button', { name: 'Expand sidebar' }));
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.weft-shell-sidebar--overlay')).toBeNull();

    await fireEvent.click(getByRole('button', { name: 'Expand sidebar' }));
    const scrim = container.querySelector('.weft-shell-sidebar-scrim');
    expect(scrim).not.toBeNull();
    await fireEvent.click(scrim!);
    expect(container.querySelector('.weft-shell-sidebar--overlay')).toBeNull();
  });
});

describe('the sidebar as a drawer (04a, 04c, 05r, 07h, 07k)', () => {
  test('is closed until the menu button opens it, and has no rail or column of its own', () => {
    onPhone();
    stubEngine();
    landAt('/');
    const navigation = navigationState();
    const { container, queryByRole } = mount({ navigation });
    expect(navigation.mode).toBe('drawer');
    expect(queryByRole('dialog')).toBeNull();
    expect(container.querySelector('.weft-shell-sidebar--expanded')).toBeNull();
  });

  test('opens as a dialog holding the same rows, headed by the product name (05r)', async () => {
    onPhone();
    stubEngine({ bureauReviews: 2, attention: 3 });
    landAt('/');
    const navigation = navigationState();
    const { getByRole, findByRole } = mount({ navigation });
    navigation.drawerOpen = true;

    const dialog = await findByRole('dialog');
    expect(dialog.querySelector('.cinder-drawer__title')?.textContent?.trim()).toBe('Interborough');
    expect(getByRole('button', { name: 'Close navigation' })).not.toBeNull();
    const links = Array.from(dialog.querySelectorAll('nav a')).map(labelOf);
    expect(links).toEqual(ROW_LABELS);
    expect(dialog.querySelector('a[aria-current="page"]')?.getAttribute('href')).toBe('/');
    await waitFor(() => expect(getByRole('link', { name: 'Reviews, 2 need you' })).not.toBeNull());
    await waitFor(() =>
      expect(getByRole('link', { name: 'Health, 3 need attention' })).not.toBeNull(),
    );
    // The rail’s collapse button belongs to the column and the rail, not to the drawer.
    expect(dialog.querySelector('.weft-shell-sidebar__brand')).toBeNull();
  });

  test('closes on navigation, and the person’s own preference is untouched', async () => {
    onPhone();
    stubEngine();
    landAt('/');
    const navigation = navigationState();
    const { getByRole, findByRole, queryByRole } = mount({ navigation });
    navigation.drawerOpen = true;
    await findByRole('dialog');

    await fireEvent.click(getByRole('link', { name: /^Runs/ }));
    expect(router.pathname).toBe('/runs');
    expect(navigation.drawerOpen).toBe(false);
    await waitFor(() => expect(queryByRole('dialog')?.outerHTML ?? null).toBeNull());
    expect(window.localStorage.getItem('interborough-sidebar-collapsed')).toBeNull();
  });

  test('closes, and records that it is closed, when the drawer is dismissed', async () => {
    onPhone();
    stubEngine();
    landAt('/');
    const navigation = navigationState();
    const { findByRole, queryByRole } = mount({ navigation });
    navigation.drawerOpen = true;
    const dialog = await findByRole('dialog');
    // A click on the dialog itself is a click on its backdrop, which dismisses the drawer.
    await fireEvent.click(dialog);
    await waitFor(() => expect(queryByRole('dialog')?.outerHTML ?? null).toBeNull());
    expect(navigation.drawerOpen).toBe(false);
  });
});
