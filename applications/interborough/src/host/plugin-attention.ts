/**
 * The Needs attention items for plugins the host itself did not load (COR-2009,
 * `host:plugin-load-status`): a plugin folder whose code could not be loaded (`load-failed`), and a
 * plugin skipped for declaring a secret the host cannot honor (`secret-refused`). Neither reaches
 * the Bureau, so the Bureau's own `plugin-not-loaded` items cannot name them; the host hands them
 * over through `BureauOptions.attention`, and the Bureau lists a plugin once when both report it.
 *
 * A plugin that only waits for a secret (`needs-setup`) is never an item: the provider row already
 * covers a provider without a key, and Settings › Plugins says what to set. Each item's time is
 * when the host loaded its plugins, so Health can say "Interborough couldn't start it at 9:00 AM".
 *
 * @module plugin-attention
 */

import { basename } from 'node:path';

import type { BureauAttentionItem } from '@lostgradient/bureau';

import type { PluginSnapshot } from './plugin-manager.ts';

/**
 * A `plugin-not-loaded` item for every plugin `snapshot` lists as skipped, and for every folder that
 * could not be loaded at all, named by the folder because it has no descriptor. `loadedAt` is when
 * the host loaded its plugins, in epoch milliseconds.
 */
export function pluginAttention(
  snapshot: Pick<PluginSnapshot, 'plugins' | 'unloaded'>,
  loadedAt: number,
): BureauAttentionItem[] {
  return [
    ...snapshot.plugins.flatMap((plugin) =>
      plugin.status === 'skipped'
        ? [
            {
              kind: 'plugin-not-loaded' as const,
              area: 'plugins' as const,
              at: loadedAt,
              plugin: plugin.descriptor.name,
              problems: plugin.problems.map((problem) => problem.code),
            },
          ]
        : [],
    ),
    ...snapshot.unloaded.map((folder) => ({
      kind: 'plugin-not-loaded' as const,
      area: 'plugins' as const,
      at: loadedAt,
      plugin: basename(folder.location),
      problems: folder.problems.map((problem) => problem.code),
    })),
  ];
}
