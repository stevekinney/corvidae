/**
 * COR-2213: the icons a plugin's sidebar entry may ask for. The list and the default are fixed by
 * the issue, every name must be a real Lucide icon, and any other name draws the default.
 */
import * as lucide from '@lucide/svelte';
import { describe, expect, test } from 'bun:test';

import { DEFAULT_PLUGIN_ICON, PLUGIN_ICON_NAMES, pluginIcon } from './plugin-icons.ts';

/** `chart-line` is Lucide's `ChartLine`. */
function componentName(name: string): string {
  return name
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
}

describe('the plugin icon allowlist', () => {
  test('is exactly the eight names of the issue, with puzzle as the default', () => {
    expect([...PLUGIN_ICON_NAMES]).toEqual([
      'puzzle',
      'plug',
      'blocks',
      'chart-line',
      'list-checks',
      'bell',
      'workflow',
      'book-open',
    ]);
    expect(DEFAULT_PLUGIN_ICON).toBe('puzzle');
  });

  test('names a component @lucide/svelte exports, for every entry', () => {
    for (const name of PLUGIN_ICON_NAMES) {
      const exported: unknown = Reflect.get(lucide, componentName(name));
      expect(exported, name).toBeDefined();
      expect(pluginIcon(name), name).toBe(exported as typeof lucide.Puzzle);
    }
  });

  test('draws the default for a name outside the list, an inherited key, or no name', () => {
    for (const name of ['sparkles', 'Puzzle', '', 'constructor', '__proto__', undefined]) {
      expect(pluginIcon(name), String(name)).toBe(lucide.Puzzle);
    }
  });
});
