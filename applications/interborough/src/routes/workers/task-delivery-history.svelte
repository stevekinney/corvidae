<script lang="ts">
  /**
   * Result delivery history for one task (`weft.tasks.deliveries`, COR-284):
   * the server's answer to every `taskResult` a worker submitted, oldest
   * first, including the ones it rejected before they reached the ledger. It
   * is separate from the ledger's attempt history on purpose: an attempt
   * records what the ledger decided, a delivery records what the wire did.
   * Every outcome is spelled out in text; the badge adds color, not meaning.
   */
  import { Badge, DescriptionList, EmptyState, Skeleton } from '@lostgradient/cinder';
  import Lock from '@lucide/svelte/icons/lock';

  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { getClient } from '../../lib/client.ts';
  import { FAULT_TREATMENT_TITLE, faultTreatment } from '../../lib/faults.ts';
  import { truncateId } from '../../lib/format/index.ts';
  import { isForbidden, scopeReason } from '../../lib/scopes.svelte.ts';
  import { exactTimestamp } from './task-attempt-evidence.ts';
  import {
    MalformedTaskDeliveriesError,
    presentDelivery,
    type TaskDelivery,
  } from './task-delivery-evidence.ts';
  import { taskDeliveriesQuery } from './workers-data.ts';

  interface TaskDeliveryHistoryProps {
    readonly operationId: string;
  }

  let { operationId }: TaskDeliveryHistoryProps = $props();

  const client = getClient();
  const deliveriesQuery = taskDeliveriesQuery(client, () => operationId);

  const TRANSPORT_LABEL = { webSocket: 'WebSocket', longPoll: 'HTTP long-poll' } as const;

  function items(delivery: TaskDelivery) {
    return [
      { term: 'Received', definition: exactTimestamp(delivery.receivedAt) },
      { term: 'Outcome', definition: presentDelivery(delivery).explanation },
      {
        term: 'Attempt',
        definition:
          delivery.attempt === undefined
            ? 'No ledger attempt carries this token'
            : String(delivery.attempt),
      },
      { term: 'Submitted status', definition: delivery.submittedStatus },
      { term: 'Transport', definition: TRANSPORT_LABEL[delivery.transport] },
      { term: 'Worker', definition: delivery.workerId ?? 'Not identified' },
      ...(delivery.outcome === 'rejected'
        ? [{ term: 'Reason', definition: delivery.reason }]
        : delivery.oversizedPayload
          ? [{ term: 'Payload', definition: 'Oversized; retained as a digest only' }]
          : []),
      { term: 'Attempt token', definition: truncateId(delivery.attemptTokenDigest) },
    ];
  }

  const error = $derived(deliveriesQuery.error);
  const history = $derived(deliveriesQuery.data);

  /** Server deliveries carry no id; two alike in one millisecond are still two submissions. */
  function deliveryKey(delivery: {
    receivedAt: number;
    attemptTokenDigest: string;
    outcome: string;
  }): string {
    return `${delivery.receivedAt}:${delivery.attemptTokenDigest}:${delivery.outcome}`;
  }
</script>

<section class="weft-workers-panel weft-task-deliveries" aria-labelledby="task-deliveries-heading">
  <h3 id="task-deliveries-heading" class="weft-workers-panel__header">Result delivery history</h3>
  <div class="weft-task-deliveries__body">
    {#if deliveriesQuery.isPending}
      <div role="status" aria-busy="true" aria-label="Loading result delivery history">
        <Skeleton height="6rem" />
      </div>
    {:else if error && isForbidden(error)}
      <EmptyState
        title="Result delivery history is locked"
        description={`${scopeReason('system:read')} to read how the server answered each result.`}
      >
        {#snippet icon()}
          <Lock size={24} aria-hidden="true" />
        {/snippet}
      </EmptyState>
    {:else if error instanceof MalformedTaskDeliveriesError}
      <EmptyState title="Malformed server response" description={error.message} />
    {:else if error}
      {@const treatment = faultTreatment(error)}
      <EmptyState title={FAULT_TREATMENT_TITLE[treatment.kind]} description={treatment.message} />
    {:else if history}
      {#if history.droppedCount > 0}
        <p class="weft-task-deliveries__note" role="status">
          Showing the newest {history.deliveries.length} submissions. {history.droppedCount} older
          {history.droppedCount === 1 ? 'entry was' : 'entries were'} dropped to stay within the server's
          limit of {history.historyLimit}.
        </p>
      {/if}
      {#if history.deliveries.length === 0}
        <EmptyState
          title="No results submitted"
          description="No worker has submitted a result for this task, so the server has nothing to report."
        />
      {:else}
        <ol class="weft-task-deliveries__list" aria-labelledby="task-deliveries-heading">
          {#each keyedByOccurrence(history.deliveries, deliveryKey) as { key, item: delivery } (key)}
            {@const presentation = presentDelivery(delivery)}
            <li class="weft-task-deliveries__entry">
              <Badge variant={presentation.variant}>{presentation.label}</Badge>
              <DescriptionList items={items(delivery)} />
            </li>
          {/each}
        </ol>
      {/if}
    {/if}
  </div>
</section>
