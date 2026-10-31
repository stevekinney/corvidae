/**
 * The shell's shortcuts as the shell registers them (COR-1834): they register without overlapping
 * each other or the keys Cinder components handle, each `g` shortcut opens its destination, and
 * the `?` map lists ListDetail's J and K beside them.
 */
import { LIST_DETAIL_SHORTCUTS } from '@lostgradient/cinder';
import { describe, expect, test } from 'bun:test';

import { matchRoute } from '../../lib/router.svelte.ts';
import { ShortcutRegistry, type ShortcutKey } from '../../lib/shortcuts.ts';
import { SHORTCUT_COPY } from '../copy.ts';
import { DESTINATIONS, LIST_DETAIL_REGION, registerShellShortcuts } from './destinations.ts';

function key(value: string): ShortcutKey {
  return { key: value, metaKey: false, ctrlKey: false, altKey: false, editable: false };
}

function registered(): { registry: ShortcutRegistry; opened: string[]; maps: number[] } {
  const registry = new ShortcutRegistry();
  const opened: string[] = [];
  const maps: number[] = [];
  registerShellShortcuts(registry, {
    navigate: (path) => opened.push(path),
    openShortcutMap: () => maps.push(1),
  });
  return { registry, opened, maps };
}

describe('the shell’s shortcuts', () => {
  test('register without an overlap, and register again once removed', () => {
    const registry = new ShortcutRegistry();
    const actions = { navigate: () => {}, openShortcutMap: () => {} };
    const remove = registerShellShortcuts(registry, actions);
    expect(() => registerShellShortcuts(registry, actions)).toThrow(/overlaps/);
    remove();
    expect(registry.entries()).toEqual([]);
    expect(() => registerShellShortcuts(registry, actions)).not.toThrow();
  });

  test('the sidebar’s destinations are the nine U1 names, in order, each with its own letter', () => {
    expect(DESTINATIONS.map((destination) => [destination.path, destination.letter])).toEqual([
      ['/chats', 'c'],
      ['/reviews', 'v'],
      ['/agents', 'a'],
      ['/workflows', 'w'],
      ['/runs', 'r'],
      ['/schedules', 's'],
      ['/goals', 'l'],
      ['/health', 'e'],
      ['/settings', 'n'],
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
