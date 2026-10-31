<script lang="ts">
  /**
   * Engine ownership-lease status from `weft.system.lease` (COR-124). This
   * tab is the dashboard's only reader of that operation. Loading,
   * malformed response, and server faults are explicit; a failed read,
   * including a failed refetch over a cached reading, never renders a status.
   */
  import {
    Alert,
    Badge,
    DescriptionList,
    ErrorState,
    SectionHeading,
    Skeleton,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { useFleetEventsLive } from '../../app/live-polling.svelte.ts';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import {
    leaseStatusPresentation,
    loadSystemLease,
    MalformedSystemLeaseError,
  } from '../../lib/system-lease.ts';
  import QueryFaultBanner from './query-fault-banner.svelte';

  const client = getClient();

  // `lease:health-changed` asks for the lease again; the timer runs only while the fleet feed is
  // not live. The event carries the status alone, so the holder and the timestamps are read.
  const fleetLive = useFleetEventsLive();
  const leaseQuery = createQuery(() => {
    // Read here, not in the interval, which TanStack Query reads untracked.
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.systemLease(),
      queryFn: () => loadSystemLease(client),
      // poll-reason: fallback
      refetchInterval: polling ? 30_000 : false,
    };
  });

  // A failed background refetch keeps the cached lease beside the error; the
  // last reading is no longer current, so the badge and details are dropped
  // rather than shown confidently above the fault.
  const presentation = $derived(
    leaseQuery.data && !leaseQuery.isError ? leaseStatusPresentation(leaseQuery.data) : null,
  );

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

<section class="weft-health-tab__lease" aria-label="Server lease">
  <SectionHeading level={3} title="Server lease">
    {#snippet actions()}
      {#if presentation}
        <Badge variant={presentation.variant}>{presentation.label}</Badge>
      {/if}
    {/snippet}
  </SectionHeading>
  {#if leaseQuery.isPending}
    <div role="status" aria-busy="true" aria-label="Loading server lease">
      <Skeleton height="3rem" />
    </div>
  {:else if leaseQuery.error instanceof MalformedSystemLeaseError}
    <ErrorState
      title="Malformed server response"
      description={leaseQuery.error.message}
      headingLevel={4}
      variant="flat"
    />
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
    padding: var(--cinder-density-pad-block) var(--cinder-density-pad-inline);
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
    overflow-wrap: anywhere;
  }

  .weft-health-tab__hint {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }
</style>
