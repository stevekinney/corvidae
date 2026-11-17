/**
 * The fixture plugins the plugin-page host loads (`e2e-server.ts`, `E2E_PLUGIN_PAGES_PORT`), which
 * place pages in the sidebar and the palette (COR-2213). Each panel's entry is the one app
 * (`page-panel-app.ts`); the plugins differ in where their pages sit and in what state they are in:
 *
 * - `e2e-reports` ("Reports fixtures") places three pages: one in Work with an allowlisted icon, one
 *   in Build at a path of two segments with an icon outside the allowlist, and one in System with a
 *   very long title; and a fourth, with no sidebar entry, that only the palette and its address reach.
 * - `e2e-notes` ("Notes fixtures") waits for one secret, so its page opens under a note.
 * - `e2e-chores` ("Chores fixtures") needs two secrets, so its note links to Settings.
 * - `e2e-off` ("Switched off fixtures") is disabled, so it has no page and its address says so.
 */
import type { BureauPluginEntry } from '@lostgradient/bureau';
import { definePlugin, type PluginPanel } from '@lostgradient/interborough-plugin';

/** The title the long-title page carries, which no sidebar row or header can hold on one line. */
export const LONG_PAGE_TITLE =
  'A page whose title keeps going well past what a sidebar row or a phone-width header can hold';

function pagePanel(
  plugin: string,
  name: string,
  title: string,
  placement: Extract<NonNullable<PluginPanel['placements']>[number], { kind: 'page' }>,
): PluginPanel {
  return {
    name,
    title,
    uri: `ui://${plugin}/${name}/v1`,
    entry: new URL('./page-panel-app.ts', import.meta.url),
    allowedTools: [],
    placements: [placement],
  };
}

const reports = definePlugin({
  name: 'e2e-reports',
  title: 'Reports fixtures',
  version: '1.0.0',
  description: 'Places pages in the sidebar for the plugin-page specification.',
  setup: () => ({
    panels: [
      pagePanel('e2e-reports', 'overview', 'Fixture overview', {
        kind: 'page',
        path: 'overview',
        sidebar: { group: 'work', icon: 'chart-line' },
      }),
      pagePanel('e2e-reports', 'queue', 'Review queue', {
        kind: 'page',
        path: 'reviews/queue',
        sidebar: { group: 'build', icon: 'sparkles' },
      }),
      pagePanel('e2e-reports', 'long-title', LONG_PAGE_TITLE, {
        kind: 'page',
        path: 'long-title',
        sidebar: { group: 'system' },
      }),
      pagePanel('e2e-reports', 'hidden', 'Hidden fixture', { kind: 'page', path: 'hidden' }),
    ],
  }),
});

const notes = definePlugin({
  name: 'e2e-notes',
  title: 'Notes fixtures',
  version: '1.0.0',
  description: 'A plugin that waits for one secret, for the plugin-page specification.',
  secrets: ['e2e-notes-key'],
  setup: () => ({
    panels: [
      pagePanel('e2e-notes', 'notes', 'Fixture notes', {
        kind: 'page',
        path: 'notes',
        sidebar: { group: 'work', icon: 'book-open' },
      }),
    ],
  }),
});

const chores = definePlugin({
  name: 'e2e-chores',
  title: 'Chores fixtures',
  version: '1.0.0',
  description: 'A plugin that waits for two secrets, for the plugin-page specification.',
  secrets: ['e2e-chores-first-key', 'e2e-chores-second-key'],
  setup: () => ({
    panels: [
      pagePanel('e2e-chores', 'chores', 'Fixture chores', {
        kind: 'page',
        path: 'chores',
        sidebar: { group: 'work', icon: 'list-checks' },
      }),
    ],
  }),
});

const off = definePlugin({
  name: 'e2e-off',
  title: 'Switched off fixtures',
  version: '1.0.0',
  description: 'A plugin that is disabled, for the plugin-page specification.',
  enabled: false,
  setup: () => ({
    panels: [
      pagePanel('e2e-off', 'off', 'Switched off page', {
        kind: 'page',
        path: 'off',
        sidebar: { group: 'build' },
      }),
    ],
  }),
});

/** The fixture plugins, in the order the host loads them after the workspace's own. */
export function pagePanelPlugins(): readonly BureauPluginEntry[] {
  return [reports, notes, chores, off].map((descriptor) => ({
    descriptor,
    source: 'package' as const,
    location: `e2e-fixture/${descriptor.name}`,
  }));
}
