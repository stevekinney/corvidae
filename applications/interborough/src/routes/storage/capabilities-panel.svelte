<script lang="ts">
  /**
   * Capabilities panel: the storage backend's capability profile exactly as
   * `weft.storage.capabilities` reports it (persistence, read-after-write,
   * scan consistency, atomic batch, conditional batch, bounded range
   * delete). Nothing is inferred from other operations.
   *
   * Only `conditionalBatch` gates a control in this console (the batch
   * panel's conditional section); the other five are displayed because
   * Weft treats them as trusted contracts or operational hints and does not
   * gate on them (`WEFT/src/storage/capabilities.ts`).
   */
  import { Badge, DescriptionList, Skeleton } from '@lostgradient/cinder';
  import type { StorageCapabilities } from '@lostgradient/storage';

  import QueryFaultBanner from '../system/query-fault-banner.svelte';

  interface CapabilitiesPanelProps {
    capabilities: StorageCapabilities | undefined;
    loading: boolean;
    error: unknown;
    onRetry?: (() => void) | undefined;
  }

  let { capabilities, loading, error, onRetry = undefined }: CapabilitiesPanelProps = $props();

  const PERSISTENCE_LABEL: Readonly<Record<StorageCapabilities['persistence'], string>> = {
    ephemeral: 'ephemeral (lost when the runtime exits)',
    local: 'local (durable on this host)',
    remote: 'remote (owned by a remote service)',
  };

  const READ_AFTER_WRITE_LABEL: Readonly<Record<StorageCapabilities['readAfterWrite'], string>> = {
    linearizable: 'linearizable',
    session: 'session',
    eventual: 'eventual',
  };

  const SCAN_CONSISTENCY_LABEL: Readonly<Record<StorageCapabilities['scanConsistency'], string>> = {
    snapshot: 'snapshot',
    'best-effort': 'best-effort',
  };

  const items = $derived(
    capabilities === undefined
      ? []
      : [
          { term: 'Persistence', definition: PERSISTENCE_LABEL[capabilities.persistence] },
          {
            term: 'Read after write',
            definition: READ_AFTER_WRITE_LABEL[capabilities.readAfterWrite],
          },
          {
            term: 'Scan consistency',
            definition: SCAN_CONSISTENCY_LABEL[capabilities.scanConsistency],
          },
          { term: 'Atomic batch', definition: atomicBatchBadge },
          { term: 'Conditional batch', definition: conditionalBatchBadge },
          { term: 'Bounded range delete', definition: boundedRangeDeleteBadge },
        ],
  );
</script>

{#snippet supportBadge(supported: boolean)}
  <Badge variant={supported ? 'success' : 'neutral'}>
    {supported ? 'supported' : 'not supported'}
  </Badge>
{/snippet}

{#snippet atomicBatchBadge()}
  {@render supportBadge(capabilities?.atomicBatch === true)}
{/snippet}

{#snippet conditionalBatchBadge()}
  {@render supportBadge(capabilities?.conditionalBatch === true)}
{/snippet}

{#snippet boundedRangeDeleteBadge()}
  {@render supportBadge(capabilities?.boundedRangeDelete === true)}
{/snippet}

<div class="weft-storage-capabilities">
  {#if loading}
    <div role="status" aria-busy="true" aria-label="Loading storage capabilities">
      <Skeleton height="8rem" />
    </div>
  {:else if error}
    <QueryFaultBanner {error} {onRetry} />
  {:else if capabilities !== undefined}
    <DescriptionList {items} />
  {/if}
</div>
