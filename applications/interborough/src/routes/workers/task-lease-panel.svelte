<script lang="ts">
  /**
   * Lease clocks and cancellation evidence for one task (COR-124). The three
   * clocks (session lease, attempt lease, absolute execution deadline) are
   * separate because they expire independently: heartbeats renew only the
   * first. Cancellation is reported from the ledger and the owning attempt,
   * never inferred from an expired clock. See `task-attempt-evidence.ts`.
   */
  import { Badge, DescriptionList } from '@lostgradient/cinder';

  import { formatDuration, formatRelativeTime } from '../../lib/format/index.ts';
  import {
    buildLeaseClocks,
    describeCancellation,
    exactTimestamp,
  } from './task-attempt-evidence.ts';
  import { TASK_HEARTBEAT_STALE_AFTER_MS, type TaskLedgerDetail } from './worker-catalog-types.ts';

  interface TaskLeasePanelProps {
    readonly task: TaskLedgerDetail;
    readonly now: number;
    /** Heartbeat age at or past which a running attempt reads as stale. */
    readonly staleHeartbeatAfterMs?: number | undefined;
  }

  let {
    task,
    now,
    staleHeartbeatAfterMs = TASK_HEARTBEAT_STALE_AFTER_MS,
  }: TaskLeasePanelProps = $props();

  const RUNNING_STATES: ReadonlySet<TaskLedgerDetail['state']> = new Set([
    'leased',
    'completing',
    'cancelling',
  ]);

  const clocks = $derived(buildLeaseClocks(task, now));
  const cancellation = $derived(describeCancellation(task));
  const running = $derived(RUNNING_STATES.has(task.state));
  const heartbeatAge = $derived(
    task.lastHeartbeatAt === undefined ? undefined : now - task.lastHeartbeatAt,
  );
  const heartbeatStale = $derived(
    running && heartbeatAge !== undefined && heartbeatAge >= staleHeartbeatAfterMs,
  );

  const cancellationItems = $derived([
    { term: 'Intent', definition: cancellation.reason ?? 'No reason recorded' },
    {
      term: 'Requested at',
      definition:
        cancellation.requestedAt === undefined
          ? 'No request recorded'
          : `${exactTimestamp(cancellation.requestedAt)} (${formatRelativeTime(cancellation.requestedAt, now)})`,
    },
    { term: 'Worker acknowledgement', definition: cancellation.acknowledgement },
    ...(cancellation.earlierCancelledAttempts.length > 0
      ? [
          {
            term: 'Earlier attempts',
            definition: `Attempt ${cancellation.earlierCancelledAttempts.join(', ')} recorded cancellation; that does not acknowledge attempt ${task.attempt}`,
          },
        ]
      : []),
  ]);
</script>

<section class="weft-workers-panel" aria-labelledby="task-lease-clocks-heading">
  <h3 id="task-lease-clocks-heading" class="weft-workers-panel__header">Lease clocks</h3>
  <ul class="weft-task-lease-clocks">
    {#each clocks as clock (clock.id)}
      <li class="weft-task-lease-clocks__clock" data-clock={clock.id} data-state={clock.state}>
        <div class="weft-task-lease-clocks__heading">
          <span class="weft-task-lease-clocks__label">{clock.label}</span>
          <Badge variant={clock.variant}>{clock.stateLabel}</Badge>
        </div>
        {#if clock.deadline !== undefined}
          <p class="weft-task-lease-clocks__time">
            <time datetime={exactTimestamp(clock.deadline)}>{exactTimestamp(clock.deadline)}</time>
            <span>({formatRelativeTime(clock.deadline, now)})</span>
          </p>
        {/if}
        <p class="weft-task-lease-clocks__description">{clock.description}</p>
      </li>
    {/each}
    {#if running}
      <li class="weft-task-lease-clocks__clock" data-clock="heartbeat">
        <div class="weft-task-lease-clocks__heading">
          <span class="weft-task-lease-clocks__label">Heartbeat</span>
          {#if heartbeatAge === undefined}
            <Badge variant="neutral">No heartbeat yet</Badge>
          {:else}
            <Badge variant={heartbeatStale ? 'danger' : 'success'}
              >{heartbeatStale ? 'Stale' : 'Fresh'}</Badge
            >
          {/if}
        </div>
        {#if task.lastHeartbeatAt !== undefined && heartbeatAge !== undefined}
          <p class="weft-task-lease-clocks__time">
            <time datetime={exactTimestamp(task.lastHeartbeatAt)}
              >{exactTimestamp(task.lastHeartbeatAt)}</time
            >
            <span>({formatDuration(heartbeatAge)} old)</span>
          </p>
        {/if}
        <p class="weft-task-lease-clocks__description">
          Stale after {formatDuration(staleHeartbeatAfterMs)} without a heartbeat.
        </p>
      </li>
    {/if}
  </ul>
</section>

<section
  class="weft-workers-panel weft-task-cancellation"
  aria-labelledby="task-cancellation-heading"
  data-cancellation={cancellation.status}
>
  <div class="weft-workers-panel__header weft-task-cancellation__header">
    <h3 id="task-cancellation-heading">Cancellation evidence</h3>
    <Badge variant={cancellation.variant}>{cancellation.statusLabel}</Badge>
  </div>
  <DescriptionList items={cancellationItems} />
</section>
