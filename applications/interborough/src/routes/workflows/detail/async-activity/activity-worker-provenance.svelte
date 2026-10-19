<script lang="ts" module>
  /** How long a read task record stays fresh, so a panel opened right after a probe reuses it. */
  export const PROVENANCE_STALE_TIME_MS = 10_000;
</script>

<script lang="ts">
  /**
   * Worker provenance for one remote-mode activity (COR-281): the task
   * ledger's per-attempt history for the activity's operation id, which a
   * remote-mode `ctx.run()` shares with its pending async-activity token
   * (`pending-async-activity-token.ts`). It reuses the Workers route's
   * attempt history, so the run page and the Task Ledger show the same
   * requirement, worker identity, and cross-build markers, and links to the
   * full ledger rather than copying it.
   *
   * `operationId` is the ledger's operation id, which for a remote `ctx.run()` is the activity's
   * async token, not the pending record's own `operationId` (the workflow operation's, regenerated
   * on every yield).
   */
  import { EmptyState, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import Lock from '@lucide/svelte/icons/lock';

  import { FAULT_TREATMENT_TITLE, faultTreatment } from '../../../../lib/faults.ts';
  import { queryKeys } from '../../../../lib/query.ts';
  import { router } from '../../../../lib/router.svelte.ts';
  import { isForbidden, scopeReason } from '../../../../lib/scopes.svelte.ts';
  import { taskLedgerDeepLink } from '../../../workers/provenance-filters.ts';
  import TaskAttemptHistory from '../../../workers/task-attempt-history.svelte';
  import {
    MalformedTaskLedgerError,
    parseTaskLedgerDetail,
  } from '../../../workers/workers-data.ts';

  interface ActivityWorkerProvenanceProps {
    readonly operationId: string;
    /** Reads one task ledger record (`weft.tasks.get`). */
    readonly readTask: (input: { operationId: string }) => Promise<unknown>;
    /** The panel's heading; one run may show several attempts' panels, each named for its attempt. */
    readonly heading?: string | undefined;
  }

  let {
    operationId,
    readTask,
    heading = 'Worker provenance',
  }: ActivityWorkerProvenanceProps = $props();
  const instanceId = $props.id();
  const headingId = `activity-provenance-heading-${instanceId}`;

  const taskQuery = createQuery(() => ({
    queryKey: queryKeys.tasks.detail(operationId),
    queryFn: async () => parseTaskLedgerDetail(await readTask({ operationId })),
    staleTime: PROVENANCE_STALE_TIME_MS,
    retry: false,
  }));

  const error = $derived(taskQuery.error);
  const notRecorded = $derived(error !== null && faultTreatment(error).kind === 'not-found');
  const ledgerPath = $derived(taskLedgerDeepLink(operationId));
</script>

<section class="weft-activity-provenance" aria-labelledby={headingId}>
  <h3 id={headingId} class="weft-activity-provenance__heading">{heading}</h3>
  {#if taskQuery.isPending}
    <div role="status" aria-busy="true" aria-label="Loading worker provenance">
      <Skeleton height="6rem" />
    </div>
  {:else if error && isForbidden(error)}
    <EmptyState
      title="Worker provenance is locked"
      description={`${scopeReason('system:read')} to read which worker ran each attempt.`}
    >
      {#snippet icon()}
        <Lock size={24} aria-hidden="true" />
      {/snippet}
    </EmptyState>
  {:else if error instanceof MalformedTaskLedgerError}
    <EmptyState title="Malformed server response" description={error.message} />
  {:else if notRecorded}
    <EmptyState
      title="No worker task recorded"
      description="The task ledger holds no record for this activity, so no worker has run it."
    />
  {:else if error}
    {@const treatment = faultTreatment(error)}
    <EmptyState title={FAULT_TREATMENT_TITLE[treatment.kind]} description={treatment.message} />
  {:else if taskQuery.data}
    <TaskAttemptHistory task={taskQuery.data} />
    <a
      class="weft-activity-provenance__link"
      href={router.href(ledgerPath)}
      onclick={(event) => {
        event.preventDefault();
        router.navigate(ledgerPath);
      }}>Open the full task ledger</a
    >
  {/if}
</section>

<style>
  .weft-activity-provenance {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .weft-activity-provenance__heading {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-activity-provenance__link {
    font-size: var(--cinder-text-xs);
  }
</style>
