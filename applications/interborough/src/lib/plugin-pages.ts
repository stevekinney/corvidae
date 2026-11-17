/**
 * The pages plugins add to Interborough (COR-2212, COR-2213): each `page` placement of a panel that
 * `GET /host/panels` lists is one page, at `/plugins/<plugin>/<path>`, and when it declares a
 * `sidebar` entry it is also one entry in that group of the sidebar. The host lists panels in the
 * order the plugins loaded, so that order is the order of the entries.
 */
import type { HostPanel } from './host-panels.ts';

/** The sidebar groups a plugin's page may name, which are the sidebar's own after Home. */
export type PluginPageGroup = 'work' | 'build' | 'system';

/** One page a plugin adds. */
export interface PluginPage {
  /** The plugin that contributes the panel. */
  readonly plugin: string;
  /** The panel's name within its plugin, which the host serves its page under. */
  readonly app: string;
  /** The panel's title, which names the page everywhere a person reads it. */
  readonly title: string;
  /** The placement's declared path, without a leading slash: `reviews` or `reviews/queue`. */
  readonly path: string;
  /** The sidebar entry the placement asks for; a page with none is reached from the palette and its address. */
  readonly sidebar?:
    { readonly group: PluginPageGroup; readonly icon?: string | undefined } | undefined;
}

/**
 * The address of a page: `/plugins/<plugin>/<path>`, each segment encoded as the router decodes
 * it. A page's path is a grammar of lowercase words, so encoding changes nothing for a valid one.
 */
export function pluginPageAddress(plugin: string, path: string): string {
  return `/plugins/${encodeURIComponent(plugin)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Every page `panels` place, in the order the host lists them. A plugin whose two placements share a
 * path has the first of them: the later one is not a page of its own.
 */
export function pluginPagesOf(panels: readonly HostPanel[]): readonly PluginPage[] {
  const pages: PluginPage[] = [];
  const seen = new Set<string>();
  for (const panel of panels) {
    for (const placement of panel.placements) {
      if (placement.kind !== 'page') continue;
      const address = pluginPageAddress(panel.plugin, placement.path);
      if (seen.has(address)) continue;
      seen.add(address);
      pages.push({
        plugin: panel.plugin,
        app: panel.app,
        title: panel.title,
        path: placement.path,
        sidebar: placement.sidebar,
      });
    }
  }
  return pages;
}

/** The page at `/plugins/<plugin>/<path>`, or `undefined` when no listed panel places one there. */
export function findPluginPage(
  panels: readonly HostPanel[],
  plugin: string,
  path: string,
): PluginPage | undefined {
  return pluginPagesOf(panels).find((page) => page.plugin === plugin && page.path === path);
}
