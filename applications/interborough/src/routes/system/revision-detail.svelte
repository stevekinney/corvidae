<script lang="ts">
  /**
   * One installed revision's full record, read with
   * `weft.workflows.revisions.get` (COR-1464) when an operator selects a row
   * in `<WorkflowRevisionsPanel>`. The operation is the source of truth for
   * the record, so this reads it fresh instead of reusing the list row:
   * a revision uninstalled since the list loaded shows the operation's own
   * not-found fault. Loading, malformed, and fault states are explicit.
   */
  import { Button, CodeBlock, DescriptionList, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import QueryFaultBanner from './query-fault-banner.svelte';
  import { revisionDetail } from './revision-detail-view.ts';

  interface Props {
    workflowName: string;
    revision: string;
    onClose: () => void;
  }

  let { workflowName, revision, onClose }: Props = $props();

  const client = getClient();

  const recordQuery = createQuery(() => ({
    queryKey: queryKeys.catalog.revision(workflowName, revision),
    queryFn: (): Promise<unknown> =>
      client.operations['weft.workflows.revisions.get']({ name: workflowName, revision }),
  }));

  const detail = $derived(recordQuery.isSuccess ? revisionDetail(recordQuery.data) : undefined);
</script>

<section class="weft-revision-detail" aria-label={`Revision ${revision} detail`}>
  <div class="weft-revision-detail__header">
    <h4 class="weft-revision-detail__title">Revision detail</h4>
    <Button size="sm" variant="ghost" label="Close detail" onclick={onClose} />
  </div>

  {#if recordQuery.isPending}
    <div role="status" aria-busy="true" aria-label="Loading revision detail">
      <Skeleton height="8rem" />
    </div>
  {:else if recordQuery.isError}
    <QueryFaultBanner error={recordQuery.error} onRetry={() => recordQuery.refetch()} />
  {:else if detail === undefined}
    <div class="weft-revision-detail__malformed" role="alert">
      The server returned a revision record this console doesn't recognize — showing nothing rather
      than a guess.
    </div>
  {:else}
    <DescriptionList
      class="weft-revision-detail__fields"
      items={detail.fields.map((field) => ({
        term: field.term,
        definition: field.value,
      }))}
    />
    <div class="weft-revision-detail__contract">
      <h5 class="weft-revision-detail__contract-title">Contract</h5>
      <CodeBlock code={detail.contractJson} language="json" copyable />
    </div>
  {/if}
</section>

<style>
  .weft-revision-detail {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
    background: var(--cinder-surface-raised);
  }

  .weft-revision-detail__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .weft-revision-detail__title,
  .weft-revision-detail__contract-title {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  /* The contract hash is one unbroken string: wrap it so the whole value stays visible. */
  :global(.weft-revision-detail__fields dt),
  :global(.weft-revision-detail__fields dd) {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .weft-revision-detail__malformed {
    padding: 10px 12px;
    border-radius: var(--cinder-radius-md);
    background: var(--cinder-status-warning-background);
    border: 1px solid var(--cinder-status-warning-border);
    color: var(--cinder-status-warning-text);
    font-size: var(--cinder-text-sm);
  }

  .weft-revision-detail__contract {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
</style>
