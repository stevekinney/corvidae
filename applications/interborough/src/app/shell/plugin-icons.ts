/**
 * The icons a plugin's page may ask for in its sidebar entry (`sidebar.icon` of a `page` placement,
 * COR-2213). A plugin names an icon by its Lucide name, and only the names listed here are drawn: a
 * name outside the list, or none, is the default. The list is short on purpose: each name is a
 * component this build bundles, so a plugin cannot make the sidebar draw anything else.
 */
import {
  Bell,
  Blocks,
  BookOpen,
  ChartLine,
  ListChecks,
  Plug,
  Puzzle,
  Workflow,
} from '@lucide/svelte';

/** The Lucide names a plugin's page may use for its sidebar entry. */
export const PLUGIN_ICON_NAMES = [
  'puzzle',
  'plug',
  'blocks',
  'chart-line',
  'list-checks',
  'bell',
  'workflow',
  'book-open',
] as const;

/** One of {@link PLUGIN_ICON_NAMES}. */
export type PluginIconName = (typeof PLUGIN_ICON_NAMES)[number];

/** The icon an entry gets when its plugin names none, or one outside {@link PLUGIN_ICON_NAMES}. */
export const DEFAULT_PLUGIN_ICON: PluginIconName = 'puzzle';

const PLUGIN_ICONS: Readonly<Record<PluginIconName, typeof Puzzle>> = {
  puzzle: Puzzle,
  plug: Plug,
  blocks: Blocks,
  'chart-line': ChartLine,
  'list-checks': ListChecks,
  bell: Bell,
  workflow: Workflow,
  'book-open': BookOpen,
};

/** The icon component for `name`, or the default one when `name` is not in the allowlist. */
export function pluginIcon(name: string | undefined): typeof Puzzle {
  const allowed = PLUGIN_ICON_NAMES.find((candidate) => candidate === name);
  return PLUGIN_ICONS[allowed ?? DEFAULT_PLUGIN_ICON];
}
