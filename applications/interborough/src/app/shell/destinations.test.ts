/**
 * The shell's shortcuts as the shell registers them (COR-1834): they register without overlapping
 * each other or the keys Cinder components handle, each `g` shortcut opens its destination, and
 * the `?` map lists ListDetail's J and K beside them.
 */
import { LIST_DETAIL_SHORTCUTS } from '@lostgradient/cinder';
import { describe, expect, test } from 'bun:test';

import type { PluginPage } from '../../lib/plugin-pages.ts';
import { matchRoute } from '../../lib/router.svelte.ts';
import { ShortcutRegistry, type ShortcutKey } from '../../lib/shortcuts.ts';
import { SHORTCUT_COPY } from '../copy/shell.ts';
import {
  actionIcon,
  DESTINATIONS,
  HEALTH_SHORTCUTS,
  LIST_DETAIL_REGION,
  pluginDestinations,
  pluginPaletteActions,
  registerShellShortcuts,
} from './destinations.ts';
import { pluginIcon } from './plugin-icons.ts';

function key(value: string): ShortcutKey {
  return { key: value, metaKey: false, ctrlKey: false, altKey: false, editable: false };
}

function registered(): {
  registry: ShortcutRegistry;
  opened: string[];
  maps: number[];
  palettes: number[];
} {
  const registry = new ShortcutRegistry();
  const opened: string[] = [];
  const maps: number[] = [];
  const palettes: number[] = [];
  registerShellShortcuts(registry, {
    navigate: (path) => opened.push(path),
    openShortcutMap: () => maps.push(1),
    openPalette: () => palettes.push(1),
  });
  return { registry, opened, maps, palettes };
}

describe('the shell’s shortcuts', () => {
  test('register without an overlap, and register again once removed', () => {
    const registry = new ShortcutRegistry();
    const actions = { navigate: () => {}, openShortcutMap: () => {}, openPalette: () => {} };
    const remove = registerShellShortcuts(registry, actions);
    expect(() => registerShellShortcuts(registry, actions)).toThrow(/overlaps/);
    remove();
    expect(registry.entries()).toEqual([]);
    expect(() => registerShellShortcuts(registry, actions)).not.toThrow();
  });

  test('the sidebar’s destinations are the thirteen names, in order, each with its own letter', () => {
    expect(DESTINATIONS.map((destination) => [destination.path, destination.letter])).toEqual([
      ['/', 'h'],
      ['/chats', 'c'],
      ['/reviews', 'r'],
      ['/runs', 'u'],
      // `x`: every letter of "checks" is taken, and Checks sits directly after Runs (C2-01).
      ['/checks', 'x'],
      ['/agents', 'a'],
      ['/workflows', 'w'],
      ['/schedules', 's'],
      ['/goals', 'l'],
      ['/capabilities', 'p'],
      ['/hooks', 'k'],
      ['/health', 'e'],
      ['/settings', 'n'],
    ]);
  });

  test('the sidebar groups them as Home, Work, Build and System (03h)', () => {
    const groups = new Map<string, string[]>();
    for (const destination of DESTINATIONS) {
      groups.set(destination.group, [...(groups.get(destination.group) ?? []), destination.view]);
    }
    expect([...groups]).toEqual([
      ['home', ['home']],
      ['work', ['chat', 'reviews', 'runs', 'checks']],
      ['build', ['agents', 'workflows', 'schedules', 'goals', 'capabilities', 'hooks']],
      ['system', ['health', 'settings']],
    ]);
  });

  test('each g shortcut opens its destination, a page the route table renders', () => {
    for (const destination of DESTINATIONS) {
      const { registry, opened } = registered();
      const where = { routePattern: '/chats', regions: [] };
      registry.handleKey(key('g'), where, 0);
      expect(registry.handleKey(key(destination.letter), where, 1), destination.path).toBe(true);
      expect(opened).toEqual([destination.path]);
      expect(matchRoute(destination.path)?.pattern).toBe(destination.path);
    }
  });

  test('G O opens Workers, G T Storage and G D the audit log, pages under Health that the sidebar does not list', () => {
    expect(HEALTH_SHORTCUTS.map((page) => [page.letter, page.path])).toEqual([
      ['o', '/health/workers'],
      ['t', '/health/storage'],
      ['d', '/health/audit'],
    ]);
    for (const page of HEALTH_SHORTCUTS) {
      const { registry, opened } = registered();
      const where = { routePattern: '/agents', regions: [] };
      registry.handleKey(key('g'), where, 0);
      expect(registry.handleKey(key(page.letter), where, 1), page.path).toBe(true);
      expect(opened).toEqual([page.path]);
      expect(matchRoute(page.path)?.pattern).toBe(page.path);
      expect(DESTINATIONS.some((destination) => destination.letter === page.letter)).toBe(false);
    }
  });

  test('the map lists all three beside the other places to go', () => {
    const { registry } = registered();
    const navigation = registry
      .groups()
      .find((group) => group.label === SHORTCUT_COPY.navigationGroup);
    expect(navigation?.shortcuts).toContainEqual({ action: 'Go to Workers', keys: ['G', 'O'] });
    expect(navigation?.shortcuts).toContainEqual({ action: 'Go to Storage', keys: ['G', 'T'] });
    expect(navigation?.shortcuts).toContainEqual({ action: 'Go to Audit log', keys: ['G', 'D'] });
  });

  test('C opens a new chat from anywhere, and is listed in the map', () => {
    const { registry, opened } = registered();
    const where = { routePattern: '/agents', regions: [] };
    expect(registry.handleKey(key('c'), where, 0)).toBe(true);
    expect(opened).toEqual(['/chats/new']);
    // The same key after G is still Go to Chat, not a new chat.
    registry.handleKey(key('g'), where, 10);
    expect(registry.handleKey(key('c'), where, 20)).toBe(true);
    expect(opened).toEqual(['/chats/new', '/chats']);
    const listed = registry.groups().find((group) => group.label === SHORTCUT_COPY.chatGroup);
    expect(listed?.shortcuts).toEqual([{ action: SHORTCUT_COPY.newChat, keys: ['C'] }]);
  });

  test('a C typed into a field starts nothing', () => {
    const { registry, opened } = registered();
    const typing = { ...key('c'), editable: true };
    expect(registry.handleKey(typing, { routePattern: '/chats/new', regions: [] }, 0)).toBe(false);
    expect(opened).toEqual([]);
  });

  test('⌘K and Ctrl+K open the palette, from a field too, and K alone does not', () => {
    const { registry, palettes } = registered();
    const where = { routePattern: '/chats', regions: [] };
    const held = { ...key('k'), metaKey: true, editable: true };
    expect(registry.handleKey(held, where, 0)).toBe(true);
    expect(registry.handleKey({ ...held, metaKey: false, ctrlKey: true }, where, 1)).toBe(true);
    // Caps Lock or Shift reports the capital, which is the same key.
    expect(registry.handleKey({ ...held, key: 'K' }, where, 2)).toBe(true);
    expect(palettes).toEqual([1, 1, 1]);
    expect(registry.handleKey(key('k'), where, 3)).toBe(false);
    expect(registry.handleKey({ ...held, altKey: true }, where, 4)).toBe(false);
    expect(palettes).toHaveLength(3);
  });

  test('⌘K is listed first in the map, under General', () => {
    const { registry } = registered();
    const general = registry.groups().find((group) => group.label === SHORTCUT_COPY.generalGroup);
    expect(general?.shortcuts[0]).toEqual({ action: SHORTCUT_COPY.openSearch, keys: ['⌘', 'K'] });
  });

  test('an action is a shortcut that acts everywhere, so the palette can run it by name', () => {
    const { registry, opened, maps } = registered();
    const actions = registry.actions();
    expect(actions.map((action) => action.label)).not.toContain(SHORTCUT_COPY.openSearch);
    expect(actions.map((action) => [action.label, action.keys.join(' ')])).toContainEqual([
      'Go to Reviews',
      'G R',
    ]);
    expect(actions.map((action) => action.label)).toContain(SHORTCUT_COPY.newChat);
    // The keys ListDetail handles itself are not actions: the registry never runs them.
    expect(actions.map((action) => action.keys.join(' '))).not.toContain('J');
    actions.find((action) => action.label === 'Go to Reviews')?.run();
    actions.find((action) => action.label === SHORTCUT_COPY.openMap)?.run();
    expect(opened).toEqual(['/reviews']);
    expect(maps).toEqual([1]);
  });

  test('? opens the shortcut map', () => {
    const { registry, maps } = registered();
    expect(registry.handleKey(key('?'), { routePattern: null, regions: [] }, 0)).toBe(true);
    expect(maps).toEqual([1]);
  });

  test('the listing holds ListDetail’s J and K, which the registry never handles', () => {
    const { registry, opened } = registered();
    const lists = registry.groups().find((group) => group.label === SHORTCUT_COPY.listGroup);
    expect(lists?.shortcuts.map((shortcut) => shortcut.keys.join(' '))).toEqual(
      LIST_DETAIL_SHORTCUTS.map((shortcut) => shortcut.keys.join(' ')),
    );
    expect(lists?.shortcuts.map((shortcut) => shortcut.keys[0])).toContain('J');
    expect(lists?.shortcuts.map((shortcut) => shortcut.keys[0])).toContain('K');
    const inList = { routePattern: '/chats', regions: [LIST_DETAIL_REGION] };
    expect(registry.handleKey(key('j'), inList, 0)).toBe(false);
    expect(opened).toEqual([]);
  });

  test('a plugin’s page takes no key, and is in no listing of the registry (COR-2213)', () => {
    const { registry } = registered();
    const before = registry.entries();
    // Plugin entries are built from the host's panels, never registered, so none can take a letter.
    pluginPaletteActions(
      PAGES,
      () => 'Acme reports',
      () => {},
    );
    expect(registry.entries()).toEqual(before);
    for (const destination of pluginDestinations(PAGES)) {
      expect(Object.hasOwn(destination, 'letter'), destination.title).toBe(false);
    }
    expect(
      registry
        .actions()
        .map((action) => action.label)
        .filter((label) => label.includes('Acme')),
    ).toEqual([]);
  });

  test('a global j would shadow ListDetail’s J, so it is refused', () => {
    const { registry } = registered();
    expect(() =>
      registry.register({
        keys: ['j'],
        label: 'Something global',
        group: 'Test',
        scope: 'global',
        handler: () => {},
      }),
    ).toThrow(/overlaps "Next row"/);
  });
});

/** The pages two plugins place: three with a sidebar entry, one icon outside the allowlist, and one with none. */
const PAGES: readonly PluginPage[] = [
  {
    plugin: 'acme',
    app: 'overview',
    title: 'Acme overview',
    path: 'overview',
    sidebar: { group: 'work', icon: 'bell' },
  },
  {
    plugin: 'acme',
    app: 'queue',
    title: 'Review queue',
    path: 'reviews/queue',
    sidebar: { group: 'build', icon: 'sparkles' },
  },
  { plugin: 'beta', app: 'hidden', title: 'Beta hidden', path: 'hidden', sidebar: undefined },
  {
    plugin: 'beta',
    app: 'status',
    title: 'Beta status',
    path: 'status',
    sidebar: { group: 'system' },
  },
];

describe('the plugin pages in the sidebar and the palette (COR-2213)', () => {
  test('a destination is each page with a sidebar entry, in order, in its group, with its allowlisted icon or the puzzle', () => {
    const destinations = pluginDestinations(PAGES);
    expect(
      destinations.map(({ plugin, path, title, group }) => ({ plugin, path, title, group })),
    ).toEqual([
      { plugin: 'acme', path: '/plugins/acme/overview', title: 'Acme overview', group: 'work' },
      {
        plugin: 'acme',
        path: '/plugins/acme/reviews/queue',
        title: 'Review queue',
        group: 'build',
      },
      { plugin: 'beta', path: '/plugins/beta/status', title: 'Beta status', group: 'system' },
    ]);
    expect(destinations[0]?.icon).toBe(pluginIcon('bell'));
    expect(destinations[1]?.icon).toBe(pluginIcon(undefined));
    expect(destinations[2]?.icon).toBe(pluginIcon(undefined));
    // Every destination matches a route, and none is Home's group.
    for (const destination of destinations) {
      expect(matchRoute(destination.path)?.pattern, destination.path).toBe('/plugins/:plugin/*');
      expect(destination.group).not.toBe('home');
    }
  });

  test('the palette lists every page, including one with no sidebar entry, as "Go to <title>" with no keys, in the navigation group', () => {
    const opened: string[] = [];
    const actions = pluginPaletteActions(
      PAGES,
      (plugin) => (plugin === 'acme' ? 'Acme reports' : undefined),
      (path) => opened.push(path),
    );
    expect(actions.map((action) => action.label)).toEqual([
      'Go to Acme overview',
      'Go to Review queue',
      'Go to Beta hidden',
      'Go to Beta status',
    ]);
    for (const action of actions) {
      expect(action.keys).toEqual([]);
      expect(action.group).toBe(SHORTCUT_COPY.navigationGroup);
    }
    // The muted line names the plugin by its title, and is left out until the host has said it.
    expect(actions.map((action) => action.meta)).toEqual([
      'From Acme reports',
      'From Acme reports',
      undefined,
      undefined,
    ]);
    actions[1]?.run();
    expect(opened).toEqual(['/plugins/acme/reviews/queue']);
  });

  test('a palette row for a plugin’s page keeps the page’s icon, and the registry’s rows keep their own', () => {
    const [overview] = pluginPaletteActions(
      PAGES,
      () => undefined,
      () => {},
    );
    if (overview === undefined) throw new Error('The first page has a palette action.');
    expect(actionIcon(overview.label, overview.icon)).toBe(pluginIcon('bell'));
    const home = DESTINATIONS.find((destination) => destination.view === 'home');
    if (home === undefined) throw new Error('Home is a destination.');
    expect(actionIcon(SHORTCUT_COPY.goTo('Home'))).toBe(home.icon);
  });
});
