/**
 * The pages plugins add, read from the host as the shell needs them (COR-2213): the panels it
 * serves, which say what each page is and where it sits, and the plugins it loaded, which say what
 * each plugin is called. Both reads go through the query cache under the keys the Plugins page and
 * the run page use, so one answer serves them all. A host that cannot answer either read has no
 * plugin pages in the sidebar or the palette, as a host with no plugins does.
 */
import { createQuery } from '@tanstack/svelte-query';

import { getPanels } from './host-panels.ts';
import { getPlugins } from './host-plugins.ts';
import { pluginPagesOf, type PluginPage } from './plugin-pages.ts';
import { queryKeys } from './query.ts';

/** What {@link usePluginPages} reads. */
export interface PluginPages {
  /** Every page the host's panels place, in the order the host lists them. */
  readonly pages: () => readonly PluginPage[];
  /** The plugin's title as a person reads it, or `undefined` before the host has said. */
  readonly pluginTitle: (plugin: string) => string | undefined;
}

/** Reads the plugin pages and the titles of their plugins; call it while a component initializes. */
export function usePluginPages(): PluginPages {
  const panels = createQuery(
    () => ({
      queryKey: queryKeys.hostPanels(),
      queryFn: ({ signal }) => getPanels({ signal }),
      retry: false,
    }),
    undefined,
  );
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      retry: false,
    }),
    undefined,
  );
  const pages = $derived(pluginPagesOf(panels.data ?? []));
  return {
    pages: () => pages,
    pluginTitle: (plugin) =>
      plugins.data?.plugins.find((standing) => standing.descriptor.name === plugin)?.descriptor
        .title,
  };
}
