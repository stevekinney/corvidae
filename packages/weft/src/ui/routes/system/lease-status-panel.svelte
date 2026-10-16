<script lang="ts">
  /**
   * Engine ownership-lease status from `weft.system.lease` (COR-124). This
   * tab is the dashboard's only reader of that operation. Loading,
   * malformed response, and server faults are explicit; a failed read never
   * renders as healthy.
   */
  import { Alert, Badge, DescriptionList, EmptyState, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import {
    leaseStatusPresentation,
    loadSystemLease,
    MalformedSystemLeaseError,
  } from '../../lib/system-lease.ts';
  import QueryFaultBanner from './query-fault-banner.svelte';

  const client = getClient();

  const leaseQuery = createQuery(() => ({
    queryKey: queryKeys.systemLease(),
    queryFn: () => loadSystemLease(client),
    refetchInterval: 30_000,
  }));

  const presentation = $derived(leaseQuery.data ? leaseStatusPresentation(leaseQuery.data) : null);

  function instant(value: number | undefined): string {
    return value === undefined ? 'Not reported' : new Date(value).toISOString();
  }

  const items = $derived(
    leaseQuery.data && leaseQuery.data.mode === 'lease'
      ? [
          { term: 'Holder', definition: leaseQuery.data.holderId ?? 'Not reported' },
          {
            term: 'Fencing epoch',
            definition:
              leaseQuery.data.fencingEpoch === undefined
                ? 'Not reported'
                : String(leaseQuery.data.fencingEpoch),
          },
          { term: 'Held since', definition: instant(leaseQuery.data.heldSince) },
          { term: 'Last renewed', definition: instant(leaseQuery.data.lastRenewedAt) },
          { term: 'Expires', definition: instant(leaseQuery.data.expiresAt) },
        ]
      : [],
  );
</script>

<section class="weft-health-tab__lease" aria-labelledby="engine-lease-heading">
  <div class="weft-health-tab__lease-header">
    <h2 id="engine-lease-heading">Engine lease</h2>
    {#if presentation}
      <Badge variant={presentation.variant}>{presentation.label}</Badge>
    {/if}
  </div>
  {#if leaseQuery.isPending}
    <div role="status" aria-busy="true" aria-label="Loading engine lease">
      <Skeleton height="3rem" />
    </div>
  {:else if leaseQuery.error instanceof MalformedSystemLeaseError}
    <EmptyState title="Malformed server response" description={leaseQuery.error.message} />
  {:else if leaseQuery.isError}
    <QueryFaultBanner error={leaseQuery.error} onRetry={() => leaseQuery.refetch()} />
  {:else if presentation}
    {#if leaseQuery.data?.status === 'contested'}
      <Alert variant="danger">{presentation.description}</Alert>
    {:else}
      <p class="weft-health-tab__hint">{presentation.description}</p>
    {/if}
    {#if items.length > 0}
      <DescriptionList {items} />
    {/if}
  {/if}
</section>

<style>
  .weft-health-tab__lease {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px;
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
    overflow-wrap: anywhere;
  }

  .weft-health-tab__lease-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .weft-health-tab__lease-header h2 {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-health-tab__hint {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }
</style>
