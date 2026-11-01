<script lang="ts">
  /**
   * Retained result of a dead-lettered task (COR-284). The ledger record keeps
   * the result's digest and why persisting it failed, which render here without
   * any request. The retained value itself (`weft.tasks.deadletters.get`) needs
   * `system:admin`, the scope that may clear the dead letter, and is read only
   * when an operator asks for it: it is the worker's raw result, shown exactly
   * as submitted, up to the server's size limit. Task input and headers are
   * never part of it.
   *
   * It also holds Retry and Clear for this one dead letter, which are the way to a dead letter the
   * queue view cannot reach: one on a queue the queue list omits, or beyond the diagnostics' page
   * size. Both need `system:admin` and are confirmed by the route root, which owns the dialogs, the
   * mutations and the refusal messages; this panel only names the dead letter, including the
   * attempt that was dead-lettered, so a retry is refused if the task has failed for good again.
   */
  import {
    Alert,
    Button,
    DescriptionList,
    EmptyState,
    PayloadInspector,
    Skeleton,
    Tooltip,
  } from '@lostgradient/cinder';

  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { formatBytes } from '../../lib/format/index.ts';
  import {
    getPrincipalStore,
    isForbidden,
    scopeGate,
    scopeReason,
  } from '../../lib/scopes.svelte.ts';
  import { deadLetterTargetFromDetail, type DeadLetterTarget } from './dead-letter-guard.ts';
  import { exactTimestamp } from './task-attempt-evidence.ts';
  import PanelFault from './panel-fault.svelte';
  import type { TaskLedgerDetail } from './worker-catalog-types.ts';
  import { deadLetterQuery } from './workers-data.ts';

  interface TaskDeadLetterPanelProps {
    readonly task: TaskLedgerDetail;
    /** Whether a retry of this task is in flight; Retry stays disabled until it settles. */
    readonly retrying?: boolean;
    readonly onRetryDeadLetter: (target: DeadLetterTarget) => void;
    readonly onClearDeadLetter: (target: DeadLetterTarget) => void;
  }

  let {
    task,
    retrying = false,
    onRetryDeadLetter,
    onClearDeadLetter,
  }: TaskDeadLetterPanelProps = $props();

  const client = getClient();
  const principalStore = getPrincipalStore();
  const adminGate = $derived(scopeGate(principalStore, ['system:admin']));

  let requested = $state(false);
  const retained = deadLetterQuery(
    client,
    () => task.operationId,
    () => requested && !adminGate.disabled,
  );

  // A real 403 means the credential lost the scope; record it once so the control locks.
  $effect(() => {
    if (isForbidden(retained.error) && principalStore.hasScope('system:admin')) {
      principalStore.denyScope('system:admin');
    }
  });

  const recordItems = $derived([
    { term: 'Result digest', definition: task.resultDigest ?? 'None' },
    { term: 'Result status', definition: task.pendingStatus ?? 'None' },
    {
      term: 'Dead-lettered at',
      definition:
        task.deadLetteredAt === undefined ? 'Unknown' : exactTimestamp(task.deadLetteredAt),
    },
    { term: 'Why persisting failed', definition: task.persistenceFailureReason ?? 'Not recorded' },
  ]);

  const target = $derived(deadLetterTargetFromDetail(task));
  const error = $derived(retained.error);
  const payload = $derived(retained.data?.payload);
</script>

<section
  class="weft-workers-panel weft-dead-letter-retention"
  aria-labelledby="dead-letter-retention-heading"
>
  <h3 id="dead-letter-retention-heading" class="weft-workers-panel__title">
    Retained dead-letter result
  </h3>
  <div class="weft-dead-letter-retention__body">
    <DescriptionList items={recordItems} />

    {#if target !== null}
      <div class="weft-dead-letter-panel__actions">
        {#if adminGate.disabled}
          <Tooltip text={adminGate.title ?? ''}>
            <Button variant="secondary" size="sm" disabled label="Retry this dead letter" />
          </Tooltip>
          <Tooltip text={adminGate.title ?? ''}>
            <Button variant="secondary" size="sm" disabled label="Clear this dead letter" />
          </Tooltip>
        {:else}
          <Button
            data-changes
            variant="secondary"
            size="sm"
            label="Retry this dead letter"
            disabled={retrying}
            onclick={() => onRetryDeadLetter(target)}
          />
          <Button
            data-changes
            variant="secondary"
            size="sm"
            label="Clear this dead letter"
            onclick={() => onClearDeadLetter(target)}
          />
        {/if}
      </div>
    {/if}

    {#if !requested}
      {#if adminGate.disabled}
        <Tooltip text={adminGate.title ?? ''}>
          <Button variant="secondary" size="sm" disabled label="Inspect retained result" />
        </Tooltip>
        <p class="weft-task-deliveries__note">
          {scopeReason('system:admin')} to read the retained value. The digest above is all this view
          can show without it.
        </p>
      {:else}
        <Button
          variant="secondary"
          size="sm"
          label="Inspect retained result"
          onclick={() => (requested = true)}
        />
        <p class="weft-task-deliveries__note">
          Reads the worker's result exactly as it was submitted. It may contain sensitive data.
        </p>
      {/if}
    {:else if retained.isPending}
      <div role="status" aria-busy="true" aria-label="Loading retained result">
        <Skeleton height="6rem" />
      </div>
    {:else if error && isForbidden(error)}
      <EmptyState
        kind="first-use"
        size="compact"
        headingLevel={4}
        title="Retained result is locked"
        description={`${scopeReason('system:admin')} to read the retained value.`}
      />
    {:else if error && faultTreatment(error).kind === 'not-found'}
      <EmptyState
        kind="done"
        size="compact"
        headingLevel={4}
        title="Dead letter no longer retained"
        description="The server holds no dead letter for this task. It may have been cleared since this page loaded."
      />
    {:else if error}
      <PanelFault {error} onRetry={() => void retained.refetch()} />
    {:else if payload?.kind === 'value'}
      <p class="weft-task-deliveries__note">
        Retained value · {formatBytes(payload.serializedBytes)} serialized
      </p>
      <PayloadInspector value={payload.value} label="Retained result" />
    {:else if payload?.kind === 'omitted'}
      <Alert variant="warning"
        >The retained value is {formatBytes(payload.serializedBytes)}, over the {formatBytes(
          payload.maxBytes,
        )} this view reads inline, so it is not shown. Its digest above identifies it.</Alert
      >
    {:else if payload?.kind === 'absent'}
      <Alert variant="info"
        >{task.pendingStatus === 'failed'
          ? 'The worker reported a failure, so its error text is the whole result and no value was retained.'
          : 'The worker completed with no value (for example, an activity that returned nothing), so none was retained.'}</Alert
      >
    {/if}
  </div>
</section>
