<script lang="ts">
  /**
   * Retained result of a dead-lettered task (COR-284). The ledger record keeps
   * the result's digest and why persisting it failed, which render here without
   * any request. The retained value itself (`weft.tasks.deadletters.get`) needs
   * `system:admin`, the scope that may clear the dead letter, and is read only
   * when an operator asks for it: it is the worker's raw result, shown exactly
   * as submitted, up to the server's size limit. Task input and headers are
   * never part of it.
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
  import { FAULT_TREATMENT_TITLE, faultTreatment } from '../../lib/faults.ts';
  import { formatBytes } from '../../lib/format/index.ts';
  import {
    getPrincipalStore,
    isForbidden,
    scopeGate,
    scopeReason,
  } from '../../lib/scopes.svelte.ts';
  import { exactTimestamp } from './task-attempt-evidence.ts';
  import { MalformedDeadLetterError } from './task-delivery-evidence.ts';
  import type { TaskLedgerDetail } from './worker-catalog-types.ts';
  import { deadLetterQuery } from './workers-data.ts';

  interface TaskDeadLetterPanelProps {
    readonly task: TaskLedgerDetail;
  }

  let { task }: TaskDeadLetterPanelProps = $props();

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
        title="Retained result is locked"
        description={`${scopeReason('system:admin')} to read the retained value.`}
      />
    {:else if error instanceof MalformedDeadLetterError}
      <EmptyState title="Malformed server response" description={error.message} />
    {:else if error && faultTreatment(error).kind === 'not-found'}
      <EmptyState
        title="Dead letter no longer retained"
        description="The server holds no dead letter for this task. It may have been cleared since this page loaded."
      />
    {:else if error}
      {@const treatment = faultTreatment(error)}
      <EmptyState title={FAULT_TREATMENT_TITLE[treatment.kind]} description={treatment.message} />
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
