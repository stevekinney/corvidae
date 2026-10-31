<script lang="ts">
  /**
   * `/health/storage`: the key explorer, and the storage line under its title. Gated on
   * `storage:admin` as a whole, not the finer `storage:read` and `storage:write` scopes the
   * operation catalog declares, which `resolveAuthorizedStorage` never honors (`storage-client.ts`'s
   * module doc; filed upstream: https://github.com/stevekinney/weft/issues/726). Writes are per key
   * (`key-detail.svelte`): there is no switch that turns them all on.
   */
  import { untrack } from 'svelte';

  import { EmptyState, PageHeader } from '@lostgradient/cinder';
  import { Lock } from '@lucide/svelte';

  import { createQuery } from '@tanstack/svelte-query';

  import { STORAGE_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { getHostPaths } from '../../lib/host-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { getPrincipalStore, scopeReason } from '../../lib/scopes.svelte.ts';
  import { storageQueryKeys } from './queries.ts';
  import StorageBackend from './storage-backend.svelte';
  import StorageExplorer from './storage-explorer.svelte';

  const client = getClient();
  const principalStore = getPrincipalStore();

  const hasStorageAdmin = $derived(principalStore.hasScope('storage:admin'));

  /**
   * `@tanstack/svelte-query`'s `createQuery` wraps a plain (non-store) options object in
   * `readable(options)` exactly once (`createBaseQuery.js`) — its `enabled` flag is genuinely a
   * one-time snapshot, never reactive, no matter how it's written. `untrack()` here says that
   * honestly instead of implying `enabled` tracks scope changes when it structurally can't. Harmless
   * if `storage:admin` is later revoked mid-session: the explorer and the line unmount via the gate
   * below, so a stale "enabled" query with no one reading it does nothing.
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

  // Where the host keeps its state, for the line under the title. A host that cannot say leaves the line bare.
  const pathsQuery = createQuery(
    () => ({
      queryKey: queryKeys.hostPaths(),
      queryFn: ({ signal }) => getHostPaths({ signal }),
      enabled: untrack(() => hasStorageAdmin),
      retry: false,
    }),
    undefined,
  );
</script>

<div class="weft-storage-route">
  <PageHeader title={STORAGE_COPY.title} description={STORAGE_COPY.description} />
  {#if hasStorageAdmin}
    <StorageBackend
      paths={pathsQuery.data}
      capabilities={capabilitiesQuery.data}
      loading={capabilitiesQuery.isPending}
      error={capabilitiesQuery.error}
      onRetry={() => void capabilitiesQuery.refetch()}
    />
  {/if}

  {#if !hasStorageAdmin}
    <EmptyState
      kind="first-use"
      title="Storage access requires storage:admin"
      description={scopeReason('storage:admin')}
    >
      {#snippet icon()}<Lock aria-hidden="true" size={22} />{/snippet}
    </EmptyState>
  {:else}
    <StorageExplorer {client} conditionalBatch={capabilitiesQuery.data?.conditionalBatch} />
  {/if}
</div>
