<script lang="ts">
  /**
   * The Runs list of a schedule's page (COR-2018, `ScheduleDetail`, "the runs timeline"): upcoming
   * runs above, a Now marker, the fires it missed folded into one band, and what it started below,
   * newest nearest the marker. It is Cinder's Timeline, so the rows, the marker, the band and the
   * labelled break where the clock changed are Cinder's.
   *
   * Upcoming runs are listed farthest first, so the nearest sits against Now. Every one offers
   * "Skip"; a skipped run keeps its row with its time crossed out, says so, and offers "Undo" in
   * place of Skip, on the row and nowhere else, until its time has passed. A run that is due and
   * will not start says why on a second line, and keeps its Skip because skipping it prevents the
   * start once things are fixed. The band opens to each missed fire, in the viewer's zone, with "Run once
   * now", which starts one run and not one per miss. A run is a status-first row that links to it;
   * one that is going or that failed says on a second line how it started and where it is or
   * stopped. A schedule that has not run says so below Now, and why it will not start.
   */
  import {
    Button,
    EmptyState,
    formatDateTime,
    Skeleton,
    Timeline,
    type TimelineEntry,
  } from '@lostgradient/cinder';
  import { Clock, SkipForward, Undo2 } from '@lucide/svelte';
  import type { ScheduleSummary } from '@lostgradient/weft';
  import { createQueries, createQuery } from '@tanstack/svelte-query';

  import { getConnection } from '../../app/connection.svelte.ts';
  import { SCHEDULE_COPY } from '../../app/copy/schedules.ts';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { browserTimeZone } from './cadence.ts';
  import FaultBanner from './fault-banner.svelte';
  import { SCHEDULE_MISSED_FIRE_LIMIT } from './past-runs-model.ts';
  import { fetchRunDetail, runDetailLine, runDetailQueryKey } from './schedule-run-details.ts';
  import {
    clockBreak,
    pastSection,
    upcomingRows,
    type ClockBreak,
    type UpcomingRow,
  } from './schedule-runs-model.ts';
  import {
    fetchScheduleRunHistory,
    scheduleMissedQueryKey,
    scheduleRunHistoryQueryKey,
  } from './schedule-queries.ts';
  import type { RowBlocker, ScheduleRow } from './schedule-row-model.ts';
  import { missedOf } from './schedule-writes.ts';

  interface Props {
    schedule: ScheduleSummary;
    row: Pick<ScheduleRow, 'status' | 'allBlockers' | 'workflowLabel'>;
    /** The clock the page counts from, read again whenever the schedule is. */
    now: number;
    /** Whether the person may skip, or undo a skip: the schedule is one an owner writes, and the scope is held. */
    canSkip: boolean;
    /** A write is in flight. */
    busy: boolean;
    /** Skips the run the button sits beside, named by its time in milliseconds since the epoch. */
    onSkip: (occurrence: number) => void;
    /** Takes back the skip of the run the button sits beside, named as {@link onSkip} names it. */
    onUnskip: (occurrence: number) => void;
    /**
     * Starts one run now. `reason` is why that is off, said as the description of the button,
     * which stays focusable so the reason can be found; `null` when it is on. `null` for a
     * schedule that offers no Run now, which then lists the misses and offers nothing beside them.
     */
    runOnce: {
      readonly reason: string | null;
      readonly disabled: boolean;
      onRun: () => void;
    } | null;
  }

  let { schedule, row, now, canSkip, busy, onSkip, onUnskip, runOnce }: Props = $props();

  const copy = SCHEDULE_COPY.detail.runs;
  const client = getClient();
  const connection = getConnection();
  const zone = browserTimeZone();

  const runs = createQuery(() => ({
    queryKey: scheduleRunHistoryQueryKey(schedule.id),
    queryFn: () => fetchScheduleRunHistory(client, schedule.id),
  }));
  const missed = createQuery(() => ({
    queryKey: scheduleMissedQueryKey(schedule.id),
    queryFn: () => missedOf(client, schedule),
  }));

  const upcoming = $derived(upcomingRows(schedule, row, now));
  const past = $derived(
    pastSection(
      runs.data?.items ?? [],
      missed.data ?? [],
      {
        // Each list is a page of the newest: one that stopped at its page says nothing of what is older.
        runs: runs.data !== undefined && runs.data.total > runs.data.items.length,
        missed: (missed.data?.length ?? 0) >= SCHEDULE_MISSED_FIRE_LIMIT,
      },
      now,
    ),
  );
  const pending = $derived(runs.isPending && missed.isPending);
  const active = $derived(row.status === 'active');

  // The runs whose second line says more than their status do: one that is going, one that failed
  // or was canceled. A run that finished well has nothing to add.
  const detailed = $derived(past.runs.filter((run) => run.needsDetail));
  const details = createQueries(() => ({
    queries: detailed.map((run) => ({
      queryKey: runDetailQueryKey(run.id),
      queryFn: () => fetchRunDetail(client, run.id),
      retry: false,
    })),
  }));
  const lineOf = $derived.by(() => {
    const lines = new Map<string, string | undefined>();
    detailed.forEach((run, index) => {
      const data = details[index]?.data;
      lines.set(
        run.id,
        runDetailLine(data, run.running ? 'running' : run.status === 'Failed' ? 'failed' : 'other'),
      );
    });
    return lines;
  });

  let bandOpen = $state(false);

  const iso = (at: number): string => new Date(at).toISOString();
  const upcomingById = $derived(
    new Map(upcoming.map((fire) => [`upcoming:${String(fire.at)}`, fire])),
  );

  function separatorOf(newer: number, older: number): TimelineEntry[] {
    const found: ClockBreak | null = clockBreak(newer, older, zone);
    if (found === null) return [];
    return [
      {
        id: `break:${String(found.at)}`,
        kind: 'separator',
        datetime: iso(found.at),
        timestamp: found.label,
        title: found.label,
      },
    ];
  }

  const entries = $derived.by<TimelineEntry[]>(() => {
    const list: TimelineEntry[] = [];
    upcoming.forEach((fire, index) => {
      list.push({
        id: `upcoming:${String(fire.at)}`,
        datetime: iso(fire.at),
        timestamp: fire.absolute,
        title: fire.relative,
        tone: 'pending',
        struck: fire.skipped,
      });
      const older = upcoming[index + 1];
      if (older !== undefined) list.push(...separatorOf(fire.at, older.at));
    });
    if (active) {
      list.push({
        id: 'now',
        kind: 'now',
        datetime: iso(now),
        timestamp: formatDateTime(now, { dayWords: false, now }),
        title: copy.now,
      });
    }
    // The newest instant the section has had so far: Now, then the band, then each run.
    let newer = now;
    const band = past.band;
    if (band !== null) {
      list.push(...separatorOf(newer, band.newest));
      list.push({
        id: 'missed',
        kind: 'band',
        tone: 'warning',
        datetime: iso(band.newest),
        timestamp: band.title,
        title: band.title,
        detail: band.detail,
        expandLabel: copy.showEach,
        collapseLabel: copy.hide,
        expanded: bandOpen,
      });
      // Closed, the band stands for its newest miss; open, it ends with its oldest.
      newer = bandOpen ? band.oldest : band.newest;
    }
    for (const run of past.runs) {
      list.push(...separatorOf(newer, run.at));
      const line = lineOf.get(run.id);
      list.push({
        id: `run:${run.id}`,
        kind: 'run',
        datetime: iso(run.at),
        timestamp: run.absolute,
        title: run.status,
        status: run.status,
        href: router.href(run.href),
        ...(line === undefined ? {} : { detail: line }),
        ...(run.duration === undefined ? {} : { duration: run.duration }),
      });
      newer = run.at;
    }
    return list;
  });

  /** The missed fires the open band lists, with the break where the clock changed between them. */
  const missRows = $derived.by<TimelineEntry[]>(() => {
    const band = past.band;
    if (band === null) return [];
    const list: TimelineEntry[] = [];
    band.rows.forEach((miss, index) => {
      list.push({
        id: `miss:${miss.key}`,
        datetime: iso(miss.at),
        timestamp: miss.absolute,
        title: miss.text,
        tone: 'warning',
        plain: true,
      });
      const older = band.rows[index + 1];
      if (older !== undefined) list.push(...separatorOf(miss.at, older.at));
    });
    return list;
  });

  const runsEmpty = $derived(!pending && past.band === null && past.runs.length === 0);
  const emptyDescription = $derived.by(() => {
    if (!active) return copy.empty.paused;
    if (row.allBlockers.length > 0) return copy.empty.blocked(reasonsOf(row.allBlockers));
    const first = upcoming.at(-1);
    return first === undefined ? copy.empty.paused : copy.empty.first(first.absolute);
  });

  /** What has to happen before the schedule starts, as the end of a sentence: "Order refund loads and a provider is connected". */
  function reasonsOf(blockers: readonly RowBlocker[]): string {
    const parts = blockers.map((blocker) => {
      switch (blocker.kind) {
        case 'cannot-load':
          return copy.empty.loads(blocker.label);
        case 'deleted':
          return copy.empty.workflowBack;
        case 'provider':
          return copy.empty.providerConnected;
      }
    });
    return parts.join(' and ');
  }

  function skipTarget(entry: TimelineEntry): UpcomingRow | undefined {
    return upcomingById.get(entry.id);
  }
</script>

<!-- While the server does not answer the shell says so once, and the runs already read stay on the page. -->
{#if runs.isError && !connection.unreachable}
  <FaultBanner
    treatment={{ ...faultTreatment(runs.error), message: SCHEDULE_COPY.detail.runsFailed }}
    onRetry={() => void runs.refetch()}
  />
{/if}
{#if missed.isError && !connection.unreachable}
  <FaultBanner
    treatment={{ ...faultTreatment(missed.error), message: SCHEDULE_COPY.detail.missedFailed }}
    onRetry={() => void missed.refetch()}
  />
{/if}
{#if !active}
  <p class="ib-records__muted" data-testid="schedule-no-upcoming">{copy.pausedNote}</p>
{/if}
{#if entries.length > 0}
  <Timeline
    {entries}
    variant="list"
    label={copy.label}
    data-testid="schedule-runs"
    onExpandedChange={(entry, open) => {
      if (entry.id === 'missed') bandOpen = open;
    }}
  >
    {#snippet children(entry)}
      {#if entry.kind === 'band'}
        <div class="ib-schedule__misses" data-testid="schedule-misses">
          {#if runOnce !== null}
            <Button
              data-changes
              mutating
              class="ib-schedule__run-once"
              variant="secondary"
              size="sm"
              disabled={runOnce.reason === null && runOnce.disabled}
              {...runOnce.reason === null ? {} : { 'aria-disabled': 'true', title: runOnce.reason }}
              onclick={() => {
                if (runOnce.reason === null) runOnce.onRun();
              }}>{copy.runOnce}</Button
            >
          {/if}
          <Timeline entries={missRows} variant="list" label={entry.title} />
        </div>
      {:else if skipTarget(entry)?.note !== undefined}
        <span class="ib-schedule__fire-note" data-tone="warning" data-testid="schedule-fire-note"
          >{skipTarget(entry)?.note}</span
        >
      {/if}
    {/snippet}
    {#snippet actions(entry)}
      {@const fire = skipTarget(entry)}
      {#if fire?.skipped}
        <span class="ib-schedule__skipped" data-testid="schedule-skipped">{copy.skipped}</span>
        {#if canSkip}
          <Button
            data-changes
            mutating
            variant="ghost-accent"
            size="sm"
            disabled={busy}
            aria-label={copy.undoLabel(fire.absolute)}
            data-testid="schedule-undo-skip"
            onclick={() => onUnskip(fire.at)}
          >
            <Undo2 aria-hidden="true" size={14} />
            {copy.undo}
          </Button>
        {/if}
      {:else if fire !== undefined && canSkip}
        <Button
          data-changes
          mutating
          variant="secondary"
          size="sm"
          disabled={busy}
          aria-label={copy.skipLabel(fire.absolute)}
          onclick={() => onSkip(fire.at)}
        >
          <SkipForward aria-hidden="true" size={14} />
          {copy.skip}
        </Button>
      {/if}
    {/snippet}
  </Timeline>
{/if}
{#if pending}
  <Skeleton height="2.5rem" />
{:else if runsEmpty}
  <EmptyState
    kind="first-use"
    size="compact"
    layout="inline"
    align="start"
    title={copy.empty.title}
    description={emptyDescription}
    headingLevel={3}
  >
    {#snippet icon()}<Clock />{/snippet}
  </EmptyState>
{/if}
