<script lang="ts">
  /**
   * Fenced, chronological attempt history from `weft.tasks.get`'s `attempts`
   * (COR-124). Ordered by attempt then claim time; each attempt's lease
   * window stops where the next attempt's begins, and a disposition recorded
   * after a newer claim is labeled fenced rather than drawn as a longer
   * window. See `task-attempt-evidence.ts` for the rules.
   */
  import { Badge, DescriptionList, EmptyState, Timeline } from '@lostgradient/cinder';
  import type { TimelineEntry, TimelineTone } from '@lostgradient/cinder';

  import { formatDuration, truncateId } from '../../lib/format/index.ts';
  import {
    buildAttemptHistory,
    exactTimestamp,
    type AttemptBadgeVariant,
    type AttemptHistoryEntry,
  } from './task-attempt-evidence.ts';
  import type { TaskLedgerDetail } from './worker-catalog-types.ts';

  interface TaskAttemptHistoryProps {
    readonly task: TaskLedgerDetail;
  }

  let { task }: TaskAttemptHistoryProps = $props();

  const TONE: Readonly<Record<AttemptBadgeVariant, TimelineTone>> = {
    success: 'success',
    warning: 'warning',
    danger: 'error',
    neutral: 'info',
  };

  const history = $derived(buildAttemptHistory(task.attempts, task.attempt));
  const byKey = $derived(new Map(history.map((entry) => [entry.key, entry])));
  const entries = $derived<TimelineEntry[]>(
    history.map((entry) => ({
      id: entry.key,
      datetime: exactTimestamp(entry.record.claimedAt),
      timestamp: exactTimestamp(entry.record.claimedAt),
      title: `Attempt ${entry.record.attempt}${entry.owning ? ' · current' : ''}`,
      tone: TONE[entry.dispositionVariant],
    })),
  );

  function windowText(entry: AttemptHistoryEntry): string {
    const start = exactTimestamp(entry.windowStart);
    if (entry.windowEnd === undefined) return `${start} → still held`;
    const end = exactTimestamp(entry.windowEnd);
    return `${start} → ${end} (${formatDuration(entry.windowEnd - entry.windowStart)})`;
  }

  function dispositionText(entry: AttemptHistoryEntry): string {
    const at = exactTimestamp(entry.record.dispositionAt);
    if (entry.record.disposition === 'leased') return `Claimed at ${at}; no disposition yet`;
    if (entry.dispositionFenced && entry.supersededBy) {
      return `Recorded at ${at}, after attempt ${entry.supersededBy.attempt} claimed the task; fenced and does not extend this window`;
    }
    return `Recorded at ${at}`;
  }

  function detailItems(entry: AttemptHistoryEntry) {
    const { record } = entry;
    return [
      { term: 'Lease window', definition: windowText(entry) },
      { term: 'Disposition', definition: dispositionText(entry) },
      { term: 'Reason', definition: record.dispositionReason ?? 'None recorded' },
      ...(entry.supersededBy && !entry.owning
        ? [
            {
              term: 'Superseded by',
              definition: `Attempt ${entry.supersededBy.attempt} at ${exactTimestamp(entry.supersededBy.claimedAt)}`,
            },
          ]
        : []),
      {
        term: 'Worker session',
        definition: record.executionIdentity
          ? `${record.executionIdentity.workerId}${record.sessionGeneration === undefined ? '' : ` · generation ${record.sessionGeneration}`}`
          : record.sessionGeneration === undefined
            ? 'Not recorded'
            : `Generation ${record.sessionGeneration}`,
      },
      {
        term: 'Attempt heartbeat',
        definition:
          record.lastHeartbeatAt === undefined
            ? 'None recorded'
            : exactTimestamp(record.lastHeartbeatAt),
      },
      { term: 'Attempt token', definition: truncateId(record.attemptTokenDigest) },
    ];
  }
</script>

<section class="weft-workers-panel weft-task-attempts" aria-labelledby="task-attempts-heading">
  <h3 id="task-attempts-heading" class="weft-workers-panel__header">Attempt history</h3>
  {#if history.length === 0}
    <EmptyState
      title="No attempts claimed"
      description="No worker has claimed this task yet, so there is no attempt history."
    />
  {:else}
    <div class="weft-task-attempts__timeline">
      <Timeline {entries} aria-labelledby="task-attempts-heading">
        {#snippet children(timelineEntry)}
          {@const entry = byKey.get(timelineEntry.id)}
          {#if entry}
            <div class="weft-task-attempts__entry" data-attempt={entry.record.attempt}>
              <Badge variant={entry.dispositionVariant}>{entry.dispositionLabel}</Badge>
              {#if entry.supersededBy && !entry.owning}
                <Badge variant="neutral">Superseded</Badge>
              {/if}
              <DescriptionList items={detailItems(entry)} />
            </div>
          {/if}
        {/snippet}
      </Timeline>
    </div>
  {/if}
</section>
