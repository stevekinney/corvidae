<script lang="ts">
  /**
   * Fenced, chronological attempt history from `weft.tasks.get`'s `attempts`
   * (COR-124). Ordered by attempt then claim time; each attempt's lease
   * window stops where the next attempt's begins, and a disposition recorded
   * after a newer claim is labeled fenced rather than drawn as a longer
   * window. See `task-attempt-evidence.ts` for the rules.
   */
  import { Badge, Button, DescriptionList, EmptyState, Timeline } from '@lostgradient/cinder';
  import type { TimelineEntry, TimelineTone } from '@lostgradient/cinder';

  import { formatDuration, truncateId } from '../../lib/format/index.ts';
  import {
    ATTEMPT_HISTORY_PAGE_SIZE,
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

  // Fencing and order come from the whole history; only the newest
  // `pageCount` pages are mounted, so an unbounded history stays cheap.
  const history = $derived(buildAttemptHistory(task.attempts, task.attempt));
  let pageCount = $state(1);
  const shownCount = $derived(Math.min(history.length, pageCount * ATTEMPT_HISTORY_PAGE_SIZE));
  const shown = $derived(history.slice(history.length - shownCount));
  const olderCount = $derived(Math.min(ATTEMPT_HISTORY_PAGE_SIZE, history.length - shownCount));
  const byKey = $derived(new Map(shown.map((entry) => [entry.key, entry])));
  const entries = $derived<TimelineEntry[]>(
    shown.map((entry) => ({
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

  /** The routing requirement an attempt was dispatched under, spelled out field by field. */
  function requirementText(record: AttemptHistoryEntry['record']): string {
    const fields = Object.entries(record.executionRequirement ?? {}).filter(
      ([, value]) => value !== undefined && value !== '',
    );
    return fields.length === 0
      ? 'No constraint recorded'
      : fields.map(([key, value]) => `${key}: ${value}`).join(', ');
  }

  function detailItems(entry: AttemptHistoryEntry) {
    const { record } = entry;
    return [
      { term: 'Routing requirement', definition: requirementText(record) },
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
      ...(record.executionIdentity
        ? [
            { term: 'Deployment', definition: record.executionIdentity.deploymentName },
            { term: 'Build', definition: record.executionIdentity.buildId },
            { term: 'Artifact', definition: record.executionIdentity.artifactDigest },
            { term: 'Workflow revision', definition: record.executionIdentity.workflowRevision },
            {
              term: 'Activity contract',
              definition: record.executionIdentity.activityContractHash,
            },
          ]
        : [{ term: 'Build identity', definition: 'Not recorded' }]),
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
  <h3 id="task-attempts-heading" class="weft-workers-panel__title">Attempt history</h3>
  {#if history.length === 0}
    <EmptyState
      title="No attempts claimed"
      description="No worker has claimed this task yet, so there is no attempt history."
    />
  {:else}
    {#if olderCount > 0}
      <div class="weft-task-attempts__paging">
        <p class="weft-task-attempts__paging-summary">
          Showing the newest {shownCount} of {history.length} attempts.
        </p>
        <Button
          variant="secondary"
          size="sm"
          label={`Show ${olderCount} older attempts`}
          onclick={() => (pageCount += 1)}
        />
      </div>
    {/if}
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
              {#if entry.identityChange}
                <Badge variant="warning">Crossed build</Badge>
                <p class="weft-task-attempts__identity-change">
                  Ran on a different worker artifact than attempt {entry.identityChange
                    .previousAttempt}: {entry.identityChange.summary}.
                </p>
              {/if}
              <DescriptionList items={detailItems(entry)} />
            </div>
          {/if}
        {/snippet}
      </Timeline>
    </div>
  {/if}
</section>
