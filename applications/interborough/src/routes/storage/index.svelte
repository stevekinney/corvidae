<script lang="ts">
  /**
   * Storage route (plan §9.6, T7.1): raw KV browser + capabilities panel.
   * Gated on `storage:admin` as a whole — not the finer `storage:read`/
   * `storage:write` scopes the operation catalog declares, which
   * `resolveAuthorizedStorage` never actually honors (`storage-client.ts`'s
   * module doc; filed upstream: https://github.com/stevekinney/weft/issues/726).
   */
  import { untrack } from 'svelte';

  import { EmptyState, Tabs } from '@lostgradient/cinder';
  import { Lock } from '@lucide/svelte';

  import { createQuery } from '@tanstack/svelte-query';

  import { getClient } from '../../lib/client.ts';
  import { getPrincipalStore, scopeReason } from '../../lib/scopes.svelte.ts';
  import CapabilitiesPanel from './capabilities-panel.svelte';
  import KvBrowser from './kv-browser.svelte';
  import { discoverPrefixes } from './prefix-discovery.ts';
  import { storageQueryKeys } from './queries.ts';

  const client = getClient();
  const principalStore = getPrincipalStore();

  const hasStorageAdmin = $derived(principalStore.hasScope('storage:admin'));

  /**
   * `@tanstack/svelte-query`'s `createQuery` wraps a plain (non-store)
   * options object in `readable(options)` exactly once
   * (`createBaseQuery.js`) — its `enabled` flag is genuinely a one-time
   * snapshot, never reactive, no matter how it's written. `untrack()` here
   * says that honestly (same convention `provide-client-harness.test-harness.svelte`
   * documents for the same "read once, on purpose" situation) instead of
   * implying `enabled` tracks scope changes when it structurally can't.
   * Harmless if `storage:admin` is later revoked mid-session: `KvBrowser`/
   * `CapabilitiesPanel` (the only consumers of this query) unmount via the
   * `{#if !hasStorageAdmin}` gate below, so a stale "enabled" query with no
   * one reading it does nothing.
   */
  const capabilitiesQuery = createQuery(
    () => ({
      queryKey: storageQueryKeys.capabilities(),
      queryFn: () => client.operations['weft.storage.capabilities']({}),
      enabled: untrack(() => hasStorageAdmin),
      staleTime: Infinity,
      retry: false,
    }),
    undefined,
  );

  // The prefixes the Scan panel offers. Only the picker depends on them: a read that fails leaves the
  // panel with the field to type a prefix into, as it always had.
  const prefixesQuery = createQuery(
    () => ({
      queryKey: storageQueryKeys.prefixes(),
      queryFn: () => discoverPrefixes(client),
      enabled: untrack(() => hasStorageAdmin),
      staleTime: 5 * 60_000,
      retry: false,
    }),
    undefined,
  );

  let activeTab = $state('browser');
</script>

<div class="weft-storage-route">
  <h1 class="weft-storage-title">Storage</h1>

  {#if !hasStorageAdmin}
    <EmptyState
      title="Storage access requires storage:admin"
      description={scopeReason('storage:admin')}
    >
      {#snippet icon()}<Lock aria-hidden="true" size={22} />{/snippet}
    </EmptyState>
  {:else}
    <Tabs bind:value={activeTab} fill>
      <Tabs.List label="Storage views">
        <Tabs.Trigger value="browser">KV browser</Tabs.Trigger>
        <Tabs.Trigger value="capabilities">Capabilities</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Panel value="browser">
        <KvBrowser
          {client}
          conditionalBatchSupported={capabilitiesQuery.data?.conditionalBatch}
          knownPrefixes={prefixesQuery.data ?? []}
        />
      </Tabs.Panel>
      <Tabs.Panel value="capabilities">
        <CapabilitiesPanel
          capabilities={capabilitiesQuery.data}
          loading={capabilitiesQuery.isPending}
          error={capabilitiesQuery.error}
          onRetry={() => void capabilitiesQuery.refetch()}
        />
      </Tabs.Panel>
    </Tabs>
  {/if}
</div>
