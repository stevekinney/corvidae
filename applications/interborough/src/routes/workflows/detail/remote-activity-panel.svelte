<script lang="ts">
  /**
   * The remote task behind one timeline step (COR-274): the task ledger's
   * record for the activity's dispatch, read with `weft.tasks.get` by the id
   * Weft recorded on the timeline entry (`taskOperationId`), never rebuilt from
   * the step. It shows the ledger's state as an explicit label (every state and
   * terminal disposition has its own, none reads as "ran locally"), the queue,
   * attempt, retry policy, timeouts, header key names, and execution token,
   * and links to the full task ledger.
   *
   * Loading, no record, denied, malformed, and fault states are each explicit.
   * The attempt history and worker identity stay in `activity-worker-provenance`.
   */
  import { Badge, DescriptionList, EmptyState, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import Lock from '@lucide/svelte/icons/lock';

  import { FAULT_TREATMENT_TITLE, faultTreatment } from '../../../lib/faults.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { isForbidden, scopeReason } from '../../../lib/scopes.svelte.ts';
  import { taskLedgerDeepLink } from '../../workers/provenance-filters.ts';
  import { MalformedTaskLedgerError, parseTaskLedgerDetail } from '../../workers/workers-data.ts';
  import { remoteTaskFields, remoteTaskState } from './remote-task-view.ts';

  interface RemoteActivityPanelProps {
    /** The ledger record the timeline entry names. */
    readonly operationId: string;
    /** Reads one task ledger record (`weft.tasks.get`). */
    readonly readTask: (input: { operationId: string }) => Promise<unknown>;
    /** The activity's label, for the panel's accessible name. */
    readonly label: string;
    /**
     * True when the id comes from a live pending-activity observation because the running entry
     * does not name its record yet (Weft persists it at the next checkpoint). A missing record is
     * then "not yet available", not "removed".
     */
    readonly awaitingDispatchRecord?: boolean;
  }

  let {
    operationId,
    readTask,
    label,
    awaitingDispatchRecord = false,
  }: RemoteActivityPanelProps = $props();

  const taskQuery = createQuery(() => ({
    queryKey: queryKeys.tasks.detail(operationId),
    queryFn: async () => parseTaskLedgerDetail(await readTask({ operationId })),
    retry: false,
  }));

  const error = $derived(taskQuery.error);
  const notRecorded = $derived(error !== null && faultTreatment(error).kind === 'not-found');
  const ledgerPath = $derived(taskLedgerDeepLink(operationId));
  const task = $derived(taskQuery.data);
  const state = $derived(task === undefined ? undefined : remoteTaskState(task));
  const fields = $derived(task === undefined ? [] : remoteTaskFields(task, Date.now()));
</script>

<section class="weft-remote-task" aria-label={`Remote task for ${label}`}>
  {#if taskQuery.isPending}
    <div role="status" aria-busy="true" aria-label="Loading remote task">
      <Skeleton height="6rem" />
    </div>
  {:else if error && isForbidden(error)}
    <EmptyState
      title="The remote task is locked"
      description={`${scopeReason('system:read')} to read this activity’s task record.`}
    >
      {#snippet icon()}
        <Lock size={24} aria-hidden="true" />
      {/snippet}
    </EmptyState>
  {:else if error instanceof MalformedTaskLedgerError}
    <EmptyState title="Malformed server response" description={error.message} />
  {:else if notRecorded && awaitingDispatchRecord}
    <EmptyState
      title="Dispatch record not yet available"
      description="The task ledger has no record for this activity yet. A remote activity's record appears once its dispatch is checkpointed."
    />
  {:else if notRecorded}
    <EmptyState
      title="No task record"
      description="The task ledger holds no record for this dispatch. It may have been removed after its retention window."
    />
  {:else if error}
    {@const treatment = faultTreatment(error)}
    <EmptyState title={FAULT_TREATMENT_TITLE[treatment.kind]} description={treatment.message} />
  {:else if task !== undefined && state !== undefined}
    <div class="weft-remote-task__state">
      <Badge variant={state.variant}>{state.label}</Badge>
      <span class="weft-remote-task__id" title={task.operationId}>{task.operationId}</span>
    </div>
    <DescriptionList
      class="weft-remote-task__fields"
      variant="two-column"
      items={fields.map((field) => ({ term: field.term, definition: field.value }))}
    />
    <a
      class="weft-remote-task__link"
      href={router.href(ledgerPath)}
      onclick={(event) => {
        event.preventDefault();
        router.navigate(ledgerPath);
      }}>Open the task ledger record</a
    >
  {/if}
</section>

<style>
  .weft-remote-task {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .weft-remote-task__state {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .weft-remote-task__id {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
    min-width: 0;
  }

  /* An execution token or an id has no break opportunity: wrap it so the whole value stays visible. */
  :global(.weft-remote-task__fields dt),
  :global(.weft-remote-task__fields dd) {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .weft-remote-task__link {
    font-size: var(--cinder-text-xs);
  }
</style>
