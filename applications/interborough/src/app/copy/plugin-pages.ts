/**
 * The words of a plugin's page (COR-2213, rows PL8-06 to PL8-16): the page the host opens at
 * `/plugins/<plugin>/<path>` for a panel's `page` placement. A plugin's name, a panel's name and a
 * path are never shown as words: every state names the panel by its title and the plugin by its own.
 */
import type { ViewLink } from './views.ts';

/** The plugin's name where the host has not read its title yet, so no identifier is ever shown instead. */
const UNNAMED_PLUGIN = 'The plugin';

export const PLUGIN_PAGE_COPY = {
  /** The badge on every sidebar entry a plugin adds, and the word the entry's name and tooltip end in. */
  badge: 'Plugin',
  /** The top bar's crumb before the page's title is known. */
  crumb: 'Plugin page',
  /** The one provenance phrase: the page header's line (the plugin is a link) and the palette's muted line. */
  provenance: (plugin: string): string => `From ${plugin}`,
  /** The loading state's name, announced as the page loads. */
  loading: (title: string | undefined): string =>
    title === undefined ? 'Loading page' : `Loading ${title}`,
  /** A page that failed to load, or whose app failed after opening. */
  failed: {
    title: (title: string | undefined): string =>
      title === undefined ? 'Couldn’t open this page' : `Couldn’t open ${title}`,
    description: (plugin: string | undefined): string =>
      `${plugin ?? UNNAMED_PLUGIN} didn’t send this page. Nothing you did caused it.`,
    settings: (plugin: string | undefined): string => `Open ${plugin ?? 'the plugin'} in Settings`,
  },
  /** An address no plugin serves. */
  notFound: {
    title: 'There’s no page here',
    description:
      'No plugin offers a page at this address. A plugin’s pages go away while it is disabled.',
    back: { label: 'Open Plugins', href: '/settings/plugins' } satisfies ViewLink,
  },
  /** An address whose plugin is known and disabled. */
  disabled: {
    title: (plugin: string): string => `${plugin} is disabled`,
    description: 'Its pages come back when you enable it and restart.',
    back: (plugin: string, name: string): ViewLink => ({
      label: `Open ${plugin} in Settings`,
      href: pluginSettingsPath(name),
    }),
  },
  /** A page whose plugin waits for setup: the page still opens, with one note above it. */
  needsSetup: {
    note: (plugin: string): string => `${plugin} needs setup, so parts of this page may not work.`,
    addKey: 'Add the key',
  },
  /** The toast when an app asks to open an address outside Interborough. */
  linkBlocked: (title: string): string =>
    `${title} tried to open an address outside Interborough, so it was blocked.`,
} as const;

/** Where a plugin is read and changed in Settings, with it selected. */
export function pluginSettingsPath(plugin: string): string {
  return `/settings/plugins?plugin=${encodeURIComponent(plugin)}`;
}
