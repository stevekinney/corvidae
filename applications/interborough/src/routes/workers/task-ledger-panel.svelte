<script lang="ts">
  /**
   * Query-state wrapper for one authoritative task ledger read
   * (`weft.tasks.get`): loading, denied, malformed response, and server fault
   * are each explicit before the ledger, its lease clocks, and its attempt
   * history render (COR-124).
   */
  import { EmptyState, Skeleton } from '@lostgradient/cinder';
  import Lock from '@lucide/svelte/icons/lock';

  import { isForbidden, scopeReason } from '../../lib/scopes.svelte.ts';
  import PanelFault from './panel-fault.svelte';
  import TaskLedgerDetailView from './task-ledger-detail-view.svelte';
  import type { TaskLedgerDetail } from './worker-catalog-types.ts';

  interface TaskLedgerPanelProps {
    readonly loading: boolean;
    readonly error: unknown;
    readonly task: TaskLedgerDetail | undefined;
    readonly now: number;
    readonly refreshing?: boolean;
    readonly staleHeartbeatAfterMs?: number | undefined;
    /** Reads the ledger again; the fault banner offers it when given. */
    readonly onRetry?: (() => void) | undefined;
  }

  let {
    loading,
    error,
    task,
    now,
    refreshing = false,
    staleHeartbeatAfterMs,
    onRetry = undefined,
  }: TaskLedgerPanelProps = $props();
</script>

{#if loading}
  <div role="status" aria-busy="true" aria-label="Loading task ledger">
    <Skeleton height="12rem" />
  </div>
{:else if error && isForbidden(error)}
  <EmptyState
    kind="first-use"
    headingLevel={2}
    title="Task ledger is locked"
    description={`${scopeReason('system:read')} to read lease and attempt evidence.`}
  >
    {#snippet icon()}
      <Lock size={28} aria-hidden="true" />
    {/snippet}
  </EmptyState>
{:else if error}
  <PanelFault {error} {onRetry} />
{:else if task}
  <TaskLedgerDetailView {task} {now} {refreshing} {staleHeartbeatAfterMs} />
{:else}
  <EmptyState
    kind="first-use"
    headingLevel={2}
    title="No task selected"
    description="Choose a task to inspect its ledger."
  />
{/if}
