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
  import { EmptyState, ErrorState, Skeleton } from '@lostgradient/cinder';
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
  }

  let { operationId, readTask }: ActivityWorkerProvenanceProps = $props();
  const instanceId = $props.id();
  const headingId = `activity-provenance-heading-${instanceId}`;

  const taskQuery = createQuery(() => ({
    queryKey: queryKeys.tasks.detail(operationId),
    queryFn: async () => parseTaskLedgerDetail(await readTask({ operationId })),
    retry: false,
  }));

  const error = $derived(taskQuery.error);
  const notRecorded = $derived(error !== null && faultTreatment(error).kind === 'not-found');
  const ledgerPath = $derived(taskLedgerDeepLink(operationId));
</script>

<section class="weft-activity-provenance" aria-labelledby={headingId}>
  <h3 id={headingId} class="weft-activity-provenance__heading">Worker provenance</h3>
  {#if taskQuery.isPending}
    <div role="status" aria-busy="true" aria-label="Loading worker provenance">
      <Skeleton height="6rem" />
    </div>
  {:else if error && isForbidden(error)}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={4}
      title="Worker provenance is locked"
      description={`${scopeReason('system:read')} to read which worker ran each attempt.`}
    >
      {#snippet icon()}
        <Lock size={24} aria-hidden="true" />
      {/snippet}
    </EmptyState>
  {:else if error instanceof MalformedTaskLedgerError}
    <ErrorState
      variant="flat"
      title="Malformed server response"
      description={error.message}
      headingLevel={4}
    />
  {:else if notRecorded}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={4}
      title="No worker task recorded"
      description="The task ledger holds no record for this activity. It may never have run on a worker, or its record may have aged out of the retention window."
    />
  {:else if error}
    {@const treatment = faultTreatment(error)}
    <ErrorState
      variant="flat"
      title={FAULT_TREATMENT_TITLE[treatment.kind]}
      description={treatment.message}
      headingLevel={4}
    />
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
