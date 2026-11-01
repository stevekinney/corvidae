<script lang="ts">
  /**
   * Queue detail (plan §9.4 T5.3): routing/scheduling strategy, the dead
   * letters on the queue as a table (a Tier-3 type-to-confirm clear per
   * dead-lettered task — see `clear-dead-letter-dialog.svelte`'s doc comment
   * for why this is per-`operationId`, not a single queue-wide button: the
   * server operation `weft.tasks.diagnostics.deadletters.clear` clears
   * exactly one `operationId`, so a queue with N dead-lettered tasks needs N
   * individually-confirmed clears, not one bulk action the API doesn't
   * offer), and the workers on the queue. Each dead letter also has a Retry,
   * which puts that one task back in the queue under the same ID
   * (`weft.tasks.deadletters.retry`); like Clear, it names one `operationId`.
   */
  import { Badge, Button, DescriptionList, EmptyState, Table, Tooltip } from '@lostgradient/cinder';

  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { truncateId } from '../../lib/format/index.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import { DIAGNOSTIC_GUIDANCE } from './diagnostics-guidance.ts';
  import { exactTimestamp } from './task-attempt-evidence.ts';
  import type { RoutingPolicy } from '@lostgradient/weft';
  import type {
    TaskDiagnosticItem,
    TaskQueueHealth,
    WorkerSummary,
  } from './worker-catalog-types.ts';
  import { TRANSPORT_LABEL, workerHealthPresentation } from './worker-presentation.ts';

  interface QueueDetailViewProps {
    readonly queue: TaskQueueHealth;
    readonly routingPolicy: RoutingPolicy;
    readonly workersOnQueue: readonly WorkerSummary[];
    readonly deadLetteredItems: readonly TaskDiagnosticItem[];
    readonly diagnosticItems?: readonly TaskDiagnosticItem[];
    readonly adminGate: ScopeGate;
    /** The task whose retry is in flight, if any; its Retry stays disabled until the retry settles. */
    readonly retryingOperationId?: string | undefined;
    readonly onRetryDeadLetter: (operationId: string) => void;
    readonly onClearDeadLetter: (operationId: string) => void;
    readonly onInspectTask?: (operationId: string) => void;
  }

  let {
    queue,
    routingPolicy,
    workersOnQueue,
    deadLetteredItems,
    diagnosticItems = deadLetteredItems,
    adminGate,
    retryingOperationId = undefined,
    onRetryDeadLetter,
    onClearDeadLetter,
    onInspectTask = () => {},
  }: QueueDetailViewProps = $props();

  function activityOf(item: TaskDiagnosticItem): string {
    return 'activityName' in item ? (item.activityName ?? 'Not recorded') : 'Not recorded';
  }

  function deadLetteredAtOf(item: TaskDiagnosticItem): string {
    return 'deadLetteredAt' in item && item.deadLetteredAt !== undefined
      ? exactTimestamp(item.deadLetteredAt)
      : 'Not recorded';
  }

  const strategyItems = $derived([
    { term: 'Routing', definition: routingPolicy },
    { term: 'Scheduling', definition: queue.schedulingPolicy },
  ]);
</script>

<div class="weft-queue-detail">
  <div class="weft-queue-detail__title-row">
    <span class="weft-workers-mono weft-queue-detail__name">{queue.queue}</span>
    {#if diagnosticItems.length > 0}
      <Badge variant="warning">{diagnosticItems.length} diagnostics</Badge>
    {/if}
  </div>

  <div class="weft-workers-panel">
    <div class="weft-workers-panel__title">Strategy</div>
    <DescriptionList items={strategyItems} />
  </div>

  <section class="weft-workers-panel weft-dead-letter-panel" aria-labelledby="dead-letters-heading">
    <h3 id="dead-letters-heading" class="weft-workers-panel__title weft-dead-letter-panel__title">
      <span>Dead letters</span>
      <Badge variant="danger">{deadLetteredItems.length} tasks</Badge>
    </h3>
    <p class="weft-dead-letter-panel__description">
      Tasks that failed for good. Retry queues one again under the same ID; Clear removes its
      retained record, is irreversible, and does not retry it.
    </p>
    {#if deadLetteredItems.length === 0}
      <EmptyState
        kind="done"
        size="compact"
        headingLevel={4}
        title="No dead letters"
        description="Nothing on this queue has failed for good."
      />
    {:else}
      <Table caption="Dead letters" scrollable class="weft-dead-letters-table">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Task</Table.HeaderCell>
            <Table.HeaderCell>Activity</Table.HeaderCell>
            <Table.HeaderCell>Failed for good</Table.HeaderCell>
            <Table.HeaderCell>Actions</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each deadLetteredItems as item (item.operationId)}
            <Table.Row>
              <Table.Cell>
                <span class="weft-workers-id" title={item.operationId}
                  >{truncateId(item.operationId ?? '')}</span
                >
              </Table.Cell>
              <Table.Cell
                ><span class="weft-dead-letter-panel__wrap">{activityOf(item)}</span></Table.Cell
              >
              <Table.Cell
                ><span class="weft-dead-letter-panel__wrap">{deadLetteredAtOf(item)}</span
                ></Table.Cell
              >
              <Table.Cell>
                <span class="weft-dead-letter-panel__actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    label="Inspect ledger"
                    onclick={() => item.operationId && onInspectTask(item.operationId)}
                  />
                  {#if adminGate.disabled}
                    <Tooltip text={adminGate.title ?? ''}>
                      <Button variant="secondary" size="sm" disabled label="Retry" />
                    </Tooltip>
                    <Tooltip text={adminGate.title ?? ''}>
                      <Button variant="secondary" size="sm" disabled label="Clear" />
                    </Tooltip>
                  {:else}
                    <Button
                      data-changes
                      variant="secondary"
                      size="sm"
                      label="Retry"
                      disabled={item.operationId === retryingOperationId}
                      onclick={() => item.operationId && onRetryDeadLetter(item.operationId)}
                    />
                    <Button
                      data-changes
                      variant="secondary"
                      size="sm"
                      label="Clear"
                      onclick={() => item.operationId && onClearDeadLetter(item.operationId)}
                    />
                  {/if}
                </span>
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table>
    {/if}
  </section>

  <div class="weft-workers-panel">
    <div class="weft-workers-panel__title">Recovery diagnostics</div>
    {#if diagnosticItems.length === 0}
      <EmptyState
        kind="done"
        size="compact"
        headingLevel={4}
        title="No recovery diagnostics"
        description="Nothing on this queue is delayed, stuck, stale, retrying, or waiting to be adopted."
      />
    {:else}
      <ul class="weft-dead-letter-panel__list">
        {#each keyedByOccurrence(diagnosticItems, (candidate) => candidate.kind + (candidate.operationId ?? candidate.queue)) as { key, item } (key)}
          {@const guidance = DIAGNOSTIC_GUIDANCE[item.kind]}
          <li class="weft-dead-letter-panel__item">
            <Badge variant={guidance.variant} size="sm">{guidance.title}</Badge>
            <span>{item.evidence[0]}</span>
            {#if item.operationId}
              <Button
                variant="ghost"
                size="sm"
                label="Inspect ledger"
                onclick={() => onInspectTask(item.operationId ?? '')}
              />
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="weft-workers-panel">
    <div class="weft-workers-panel__title">Workers on this queue</div>
    {#if workersOnQueue.length === 0}
      <EmptyState
        kind="first-use"
        size="compact"
        headingLevel={4}
        title="No workers on this queue"
        description="No connected worker is polling this queue, so its tasks wait until one connects."
      />
    {:else}
      <ul class="weft-queue-workers-list">
        {#each workersOnQueue as worker (worker.id)}
          {@const presentation = workerHealthPresentation(worker)}
          <li class="weft-queue-workers-list__row">
            <span class="weft-workers-id">{truncateId(worker.id)}</span>
            <Badge variant={presentation.variant} size="sm">{presentation.label}</Badge>
            <span class="weft-queue-workers-list__transport"
              >{TRANSPORT_LABEL[worker.transport]}</span
            >
            <span class="weft-workers-mono weft-queue-workers-list__inflight"
              >{worker.inFlight}/{worker.concurrency}</span
            >
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
