<script lang="ts">
  /**
   * Query-state wrapper for one authoritative task ledger read
   * (`weft.tasks.get`): loading, denied, malformed response, and server fault
   * are each explicit before the ledger, its lease clocks, and its attempt
   * history render (COR-124).
   */
  import { EmptyState, Skeleton } from '@lostgradient/cinder';
  import Lock from '@lucide/svelte/icons/lock';

  import { FAULT_TREATMENT_TITLE, faultTreatment } from '../../lib/faults.ts';
  import { isForbidden, scopeReason } from '../../lib/scopes.svelte.ts';
  import TaskLedgerDetailView from './task-ledger-detail-view.svelte';
  import type { TaskLedgerDetail } from './worker-catalog-types.ts';
  import { MalformedTaskLedgerError } from './workers-data.ts';

  interface TaskLedgerPanelProps {
    readonly loading: boolean;
    readonly error: unknown;
    readonly task: TaskLedgerDetail | undefined;
    readonly now: number;
    readonly refreshing?: boolean;
    readonly staleHeartbeatAfterMs?: number | undefined;
  }

  let {
    loading,
    error,
    task,
    now,
    refreshing = false,
    staleHeartbeatAfterMs,
  }: TaskLedgerPanelProps = $props();
</script>

{#if loading}
  <div role="status" aria-busy="true" aria-label="Loading task ledger">
    <Skeleton height="12rem" />
  </div>
{:else if error && isForbidden(error)}
  <EmptyState
    title="Task ledger is locked"
    description={`${scopeReason('system:read')} to read lease and attempt evidence.`}
  >
    {#snippet icon()}
      <Lock size={28} aria-hidden="true" />
    {/snippet}
  </EmptyState>
{:else if error instanceof MalformedTaskLedgerError}
  <EmptyState title="Malformed server response" description={error.message} />
{:else if error}
  {@const treatment = faultTreatment(error)}
  <EmptyState title={FAULT_TREATMENT_TITLE[treatment.kind]} description={treatment.message} />
{:else if task}
  <TaskLedgerDetailView {task} {now} {refreshing} {staleHeartbeatAfterMs} />
{:else}
  <EmptyState title="No task selected" description="Choose a task to inspect its ledger." />
{/if}
