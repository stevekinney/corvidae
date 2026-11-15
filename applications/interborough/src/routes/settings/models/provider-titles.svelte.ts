/**
 * The one lookup that names a provider for the Settings pages that group by provider (Models and
 * Allowed models): its plugin's title ("Ollama"), else the name the page has words for, else the
 * identifier. Call it while a component initializes, because it starts the reads it needs.
 */
import { createQuery } from '@tanstack/svelte-query';

import { listContributedProviders } from '../../../lib/bureau-plugin-kinds.ts';
import { getPlugins } from '../../../lib/host-plugins.ts';
import { queryKeys } from '../../../lib/query.ts';
import { providerConfigurationSources, providerTitle } from './provider-configuration.ts';

export function createProviderTitles() {
  // TypeSafe is a plugin; its decision model has no key while the plugin is `needs-setup`.
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      retry: false,
    }),
    undefined,
  );
  // A provider's plugin holds its configuration: the schema comes from the Bureau and the stored
  // value from the host's plugins (the one Settings › Plugins edits).
  const contributed = createQuery(
    () => ({
      queryKey: queryKeys.contributedProviders(),
      queryFn: ({ signal }) => listContributedProviders({ signal }),
      retry: false,
    }),
    undefined,
  );
  const configurations = $derived(
    providerConfigurationSources(contributed.data ?? [], plugins.data?.plugins ?? []),
  );
  return {
    /** The host's plugins, which the page may read more of than titles. */
    plugins,
    /** Each provider's plugin source, by provider name. */
    get configurations() {
      return configurations;
    },
    /** The name a person knows the provider by. */
    title: (provider: string): string => providerTitle(provider, configurations),
  };
}
