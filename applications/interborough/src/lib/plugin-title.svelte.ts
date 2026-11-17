/**
 * The lookup that names a plugin by its title. The host's plugins are the read the shell's startup
 * banner already makes, so a page that asks for the lookup shares that answer. Call it while a
 * component initializes, because it starts the read it needs.
 */
import { createQuery } from '@tanstack/svelte-query';

import { getPlugins } from './host-plugins.ts';
import { pluginTitle } from './plugin-title.ts';
import { queryKeys } from './query.ts';

/**
 * Returns a function from a plugin's identifier to its title, or `undefined` until the host has said
 * (or when it cannot say, or does not know the plugin), so a page chooses what to say meanwhile.
 */
export function usePluginTitle(): (plugin: string) => string | undefined {
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      // A title that cannot be read is left out; it does not retry behind the person's back.
      retry: false,
    }),
    undefined,
  );
  return (plugin) => pluginTitle(plugin, plugins.data);
}
