<script lang="ts">
  /**
   * The retention overview: the default retention, how often the sweep runs and how many workflows
   * it takes at once, and how many workflow types it tracks. It lived in the System page's Health
   * tab, and is Settings › Data and retention now (`routes/settings/data-and-retention.svelte`).
   */
  import { DescriptionList } from '@lostgradient/cinder';
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

<section class="weft-retention-panel">
  <div class="weft-retention-panel__header">
    <span>Retention</span>
  </div>
  {#if retentionQuery.isPending}
    <p class="weft-retention-panel__loading">Loading…</p>
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
</section>

<style>
  .weft-retention-panel {
    max-width: 900px;
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
    padding: var(--cinder-density-pad-block) var(--cinder-density-pad-inline);
  }

  .weft-retention-panel__header {
    margin-bottom: 10px;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-retention-panel__loading {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }
</style>
