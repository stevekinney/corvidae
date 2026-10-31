<script lang="ts">
  /**
   * One worker's diagnostics, inside its detail: the tasks `weft.tasks.diagnostics` reports as stuck,
   * stale, retrying, delayed or failed for good on that worker. The server narrows the read by the
   * worker's id (the same provenance filter the Diagnostics tab accepts), so nothing here joins one
   * list against another. A fault is shown as a fault, with a way to read again.
   */
  import { Skeleton } from '@lostgradient/cinder';

  import { getClient } from '../../lib/client.ts';
  import QueryFaultBanner from '../system/query-fault-banner.svelte';
  import DiagnosticsView from './diagnostics-view.svelte';
  import { taskDiagnosticsQuery } from './workers-data.ts';

  interface WorkerDiagnosticsSectionProps {
    readonly workerId: string;
    /** Opens one task's ledger. */
    readonly onInspectTask: (operationId: string) => void;
    /** Reference instant for relative times; defaults to render time. */
    readonly now?: number;
  }

  let { workerId, onInspectTask, now = Date.now() }: WorkerDiagnosticsSectionProps = $props();

  const query = taskDiagnosticsQuery(getClient(), () => ({ workerId }));
</script>

{#if query.isPending}
  <div role="status" aria-busy="true" aria-label="Loading worker diagnostics">
    <Skeleton height="6rem" />
  </div>
{:else if query.isError && query.data === undefined}
  <QueryFaultBanner error={query.error} onRetry={() => void query.refetch()} />
{:else if query.data}
  <DiagnosticsView
    filtered
    workerScoped
    items={query.data.items}
    summary={query.data.summary}
    {now}
    {onInspectTask}
  />
{/if}
