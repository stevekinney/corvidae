<script lang="ts">
  /**
   * The retention overview: the default retention, how often the sweep runs and how many workflows
   * it takes at once, and how many workflow types it tracks. It lived in the System page's Health
   * tab, and is Settings › Data and retention now (`routes/settings/data-and-retention.svelte`).
   */
  import { Card, DescriptionList, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import type { RetentionOverview } from '@lostgradient/weft';

  import { getClient } from '../../lib/client.ts';
  import QueryFaultBanner from './query-fault-banner.svelte';

  const client = getClient();

  const retentionQuery = createQuery(() => ({
    queryKey: ['system', 'retention'],
    queryFn: (): Promise<RetentionOverview> => client.getRetentionOverview(),
  }));
</script>

<Card title="Retention" headingLevel={2}>
  {#if retentionQuery.isPending}
    <div role="status" aria-busy="true" aria-label="Loading retention">
      <Skeleton height="1.25rem" width="60%" />
      <Skeleton height="6rem" />
    </div>
  {:else if retentionQuery.isError}
    <QueryFaultBanner error={retentionQuery.error} onRetry={() => retentionQuery.refetch()} />
  {:else}
    <DescriptionList
      items={[
        {
          term: 'Default retention',
          definition: retentionQuery.data.defaultRetention
            ? JSON.stringify(retentionQuery.data.defaultRetention)
            : 'none',
        },
        { term: 'Sweep interval', definition: `${retentionQuery.data.sweepIntervalMs}ms` },
        { term: 'Sweep batch size', definition: String(retentionQuery.data.sweepBatchSize) },
        {
          term: 'Workflow types tracked',
          definition: String(retentionQuery.data.workflowTypes.length),
        },
      ]}
    />
  {/if}
</Card>
