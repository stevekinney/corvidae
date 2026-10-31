/**
 * The shortcut registry (COR-1834): the same keys may be registered in scopes that are never
 * active together, a registration that overlaps another throws, a key press runs the most specific
 * shortcut active where it happened, and a sequence waits for its next key.
 */
import { describe, expect, test } from 'bun:test';

import {
  CHORD_WINDOW_MS,
  keysCollide,
  scopesOverlap,
  ShortcutRegistry,
  type ShortcutContext,
  type ShortcutKey,
} from './shortcuts.ts';

function key(value: string, overrides: Partial<ShortcutKey> = {}): ShortcutKey {
  return {
    key: value,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    editable: false,
    ...overrides,
  };
}

const NOWHERE: ShortcutContext = { routePattern: '/chats', regions: [] };

function entry(keys: string[], scope: Parameters<typeof scopesOverlap>[0], label = keys.join(' ')) {
  return { keys, label, group: 'Test', scope, handler: () => {} };
}

describe('overlapping registrations', () => {
  test('the same keys in two scopes that can be active together are rejected', () => {
    const cases: [Parameters<typeof scopesOverlap>[0], Parameters<typeof scopesOverlap>[0]][] = [
      ['global', 'global'],
      ['global', { route: '/agents' }],
      [{ region: 'list' }, 'global'],
      [{ route: '/agents' }, { route: '/agents' }],
      [{ route: '/agents' }, { region: 'list' }],
      [{ region: 'list' }, { region: 'list' }],
    ];
    for (const [first, second] of cases) {
      const registry = new ShortcutRegistry();
      registry.register(entry(['x'], first, 'first'));
      expect(() => registry.register(entry(['x'], second, 'second'))).toThrow(/overlaps "first"/);
    }
  });

  test('a sequence that starts with another registration’s keys is rejected', () => {
    const registry = new ShortcutRegistry();
    registry.register(entry(['g', 'c'], 'global'));
    expect(() => registry.register(entry(['g'], 'global'))).toThrow(/overlaps/);
    expect(() => registry.register(entry(['g', 'c', 'x'], 'global'))).toThrow(/overlaps/);
  });

  test('a letter collides with its capital, since a component answers both', () => {
    expect(keysCollide(['j'], ['J'])).toBe(true);
    const registry = new ShortcutRegistry();
    registry.describe({
      keys: ['J'],
      label: 'Next row',
      group: 'Lists',
      scope: { region: 'list' },
    });
    expect(() => registry.register(entry(['j'], 'global'))).toThrow(/overlaps "Next row"/);
  });

  test('the same keys coexist in disjoint scopes', () => {
    const routes = new ShortcutRegistry();
    routes.register(entry(['e'], { route: '/agents' }));
    routes.register(entry(['e'], { route: '/runs' }));
    const regions = new ShortcutRegistry();
    regions.register(entry(['e'], { region: 'memory-list' }));
    regions.register(entry(['e'], { region: 'run-list' }));
    regions.register(entry(['f'], 'global'));
    expect(routes.entries().map((listed) => listed.scope)).toEqual([
      { route: '/agents' },
      { route: '/runs' },
    ]);
    expect(regions.entries().map((listed) => listed.keys.join(' '))).toEqual(['e', 'e', 'f']);
  });

  test('removing a registration frees its keys', () => {
    const registry = new ShortcutRegistry();
    const remove = registry.register(entry(['x'], 'global'));
    remove();
    expect(() => registry.register(entry(['x'], 'global'))).not.toThrow();
  });

  test('a shortcut with no keys is rejected', () => {
    expect(() => new ShortcutRegistry().register(entry([], 'global'))).toThrow(/no keys/);
  });
});

describe('a key press', () => {
  test('runs a shortcut only where its scope is active', () => {
    const ran: string[] = [];
    const registry = new ShortcutRegistry();
    registry.register({ ...entry(['e'], { route: '/agents' }), handler: () => ran.push('route') });
    registry.register({ ...entry(['t'], { region: 'tree' }), handler: () => ran.push('region') });

    expect(registry.handleKey(key('e'), { routePattern: '/runs', regions: [] }, 0)).toBe(false);
    expect(registry.handleKey(key('e'), { routePattern: '/agents', regions: [] }, 0)).toBe(true);
    expect(registry.handleKey(key('t'), { routePattern: '/agents', regions: [] }, 0)).toBe(false);
    expect(registry.handleKey(key('t'), { routePattern: '/runs', regions: ['tree'] }, 0)).toBe(
      true,
    );
    expect(ran).toEqual(['route', 'region']);
  });

  test('waits for the rest of a sequence, within the chord window', () => {
    const ran: string[] = [];
    const registry = new ShortcutRegistry();
    registry.register({ ...entry(['g', 'c'], 'global'), handler: () => ran.push('chat') });

    expect(registry.handleKey(key('g'), NOWHERE, 0)).toBe(false);
    expect(registry.handleKey(key('c'), NOWHERE, CHORD_WINDOW_MS)).toBe(true);
    expect(ran).toEqual(['chat']);

    registry.handleKey(key('g'), NOWHERE, 0);
    expect(registry.handleKey(key('c'), NOWHERE, CHORD_WINDOW_MS + 1)).toBe(false);
    expect(ran).toEqual(['chat']);
  });

  test('a key that breaks a sequence may start its own', () => {
    const ran: string[] = [];
    const registry = new ShortcutRegistry();
    registry.register({ ...entry(['g', 'c'], 'global'), handler: () => ran.push('chat') });
    registry.register({ ...entry(['?'], 'global'), handler: () => ran.push('map') });

    registry.handleKey(key('g'), NOWHERE, 0);
    expect(registry.handleKey(key('?'), NOWHERE, 1)).toBe(true);
    registry.handleKey(key('g'), NOWHERE, 2);
    registry.handleKey(key('g'), NOWHERE, 3);
    expect(registry.handleKey(key('c'), NOWHERE, 4)).toBe(true);
    expect(ran).toEqual(['map', 'chat']);
  });

  test('ignores a modifier and a key typed into a field, and drops the wait', () => {
    const ran: string[] = [];
    const registry = new ShortcutRegistry();
    registry.register({ ...entry(['g', 'c'], 'global'), handler: () => ran.push('chat') });

    for (const modified of [
      key('c', { metaKey: true }),
      key('c', { ctrlKey: true }),
      key('c', { altKey: true }),
      key('c', { editable: true }),
    ]) {
      registry.handleKey(key('g'), NOWHERE, 0);
      expect(registry.handleKey(modified, NOWHERE, 1)).toBe(false);
      expect(registry.handleKey(key('c'), NOWHERE, 2)).toBe(false);
    }
    expect(ran).toEqual([]);
  });

  test('never runs a shortcut a component handles itself', () => {
    const registry = new ShortcutRegistry();
    registry.describe({
      keys: ['J'],
      label: 'Next row',
      group: 'Lists',
      scope: { region: 'list' },
    });
    expect(registry.handleKey(key('J'), { routePattern: null, regions: ['list'] }, 0)).toBe(false);
  });
});

describe('the listing', () => {
  test('groups the shortcuts in the order each group was first registered, keys in capitals', () => {
    const registry = new ShortcutRegistry();
    registry.register({ ...entry(['?'], 'global', 'Show keyboard shortcuts'), group: 'General' });
    registry.register({ ...entry(['g', 'c'], 'global', 'Go to Chat'), group: 'Go to' });
    registry.describe({
      keys: ['Enter'],
      label: 'Open',
      group: 'Lists',
      scope: { region: 'list' },
    });
    expect(registry.groups()).toEqual([
      { label: 'General', shortcuts: [{ action: 'Show keyboard shortcuts', keys: ['?'] }] },
      { label: 'Go to', shortcuts: [{ action: 'Go to Chat', keys: ['G', 'C'] }] },
      { label: 'Lists', shortcuts: [{ action: 'Open', keys: ['Enter'] }] },
    ]);
  });
});
