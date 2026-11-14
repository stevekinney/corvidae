/**
 * What the page's cache does once the host has changed a provider's key: the provider reads
 * Connected at once, and everything that depends on the catalog is read again.
 */
import type { QueryClient } from '@tanstack/svelte-query';

import type { ProvidersSnapshot } from '../../../lib/host-providers.ts';
import { queryKeys } from '../../../lib/query.ts';

/**
 * Marks `provider` as holding a key in the cached providers, so the row reads Connected whether or
 * not the list of models that follows comes back (`models-section.svelte` says when it does not).
 */
export function markConnected(queryClient: QueryClient, provider: string): void {
  queryClient.setQueryData<ProvidersSnapshot>(queryKeys.hostProviders(), (current) =>
    current === undefined
      ? current
      : {
          ...current,
          providers: current.providers.map((entry) =>
            entry.name === provider
              ? { ...entry, configured: true, hasKey: true, connected: true }
              : entry,
          ),
        },
  );
}

/**
 * Reads again what a change of key moved: the providers, the rows that can answer decisions (a
 * provider's rows need setup until its key is saved), the agent editor's model choices, and the
 * plugin that holds the key.
 */
export function refreshAfterKeyChange(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.hostProviders() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.decisionModels() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.agents.catalog() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() });
}

/**
 * Reads again what a saved provider configuration moved. A provider's configuration applies live,
 * so a `models` allowlist or a base URL changes the providers, the Models table and its count, the
 * rows that can answer decisions, the agent editor's model choices and the plugin that holds it.
 * Resolves once they have been read.
 */
export async function refreshAfterConfigurationSave(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.hostProviders() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.decisionModels() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.catalog() }),
  ]);
}
