<script lang="ts">
  /**
   * What a schedule did: the runs it started, each linking to its run with how it ended, and the
   * fires it missed, in one table, newest first. Both are read from what the engine persisted (a
   * `scheduleId` filter on the workflow list, and the schedule's own missed-fire rows), so the same
   * rows are there after a reload, and a missed fire says why it was missed. The table reads itself
   * again when the page does.
   */
  import { Badge, EmptyState, Skeleton, Table } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { formatDuration, formatRelativeTime } from '../../lib/format/index.ts';
  import { router, workflowDetailPath } from '../../lib/router.svelte.ts';
  import { workflowRunStatusWord } from '../../lib/status.ts';
  import StatusLabel from '../../lib/status-label.svelte';
  import FaultBanner from './fault-banner.svelte';
  import { pastRows } from './past-runs-model.ts';
  import {
    fetchScheduleRunHistory,
    scheduleMissedQueryKey,
    scheduleRunHistoryQueryKey,
  } from './schedule-queries.ts';
  import { formatInZone } from './schedule-time.ts';
  import { missedOf } from './schedule-writes.ts';

  interface Props {
    schedule: { readonly id: string; readonly workflowType: string };
    /** The zone a row's time is shown in, as the title of its relative time. */
    zone: string;
  }

  let { schedule, zone }: Props = $props();

  const copy = SCHEDULE_COPY.detail;
  const client = getClient();

  const runs = createQuery(() => ({
    queryKey: scheduleRunHistoryQueryKey(schedule.id),
    queryFn: () => fetchScheduleRunHistory(client, schedule.id),
  }));
  const missed = createQuery(() => ({
    queryKey: scheduleMissedQueryKey(schedule.id),
    queryFn: () => missedOf(client, schedule),
  }));

  const rows = $derived(pastRows(runs.data?.items ?? [], missed.data ?? []));
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed-out']);

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="ib-schedule__section" aria-labelledby="ib-schedule-past-heading">
  <h2 id="ib-schedule-past-heading" class="ib-records__subheading">{copy.pastRunsHeading}</h2>
  {#if runs.isPending && missed.isPending}
    <Skeleton height="2.5rem" />
  {:else}
    {#if runs.isError}
      <FaultBanner
        treatment={{ ...faultTreatment(runs.error), message: copy.runsFailed }}
        onRetry={() => void runs.refetch()}
      />
    {/if}
    {#if missed.isError}
      <FaultBanner
        treatment={{ ...faultTreatment(missed.error), message: copy.missedFailed }}
        onRetry={() => void missed.refetch()}
      />
    {/if}
    {#if rows.length === 0 && !runs.isError && !missed.isError}
      <EmptyState
        kind="first-use"
        size="compact"
        title={copy.noPastRuns.title}
        description={copy.noPastRuns.description}
        headingLevel={3}
      />
    {:else if rows.length > 0}
      <Table caption={copy.pastRunsCaption} density="condensed">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{copy.pastColumns.when}</Table.HeaderCell>
            <Table.HeaderCell>{copy.pastColumns.outcome}</Table.HeaderCell>
            <Table.HeaderCell>{copy.pastColumns.took}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each rows as row (row.key)}
            <Table.Row data-row={row.kind}>
              <Table.Cell class="ib-records__wrap">
                {#if row.kind === 'run'}
                  {@const path = workflowDetailPath(row.run.id)}
                  <a
                    href={router.href(path)}
                    onclick={(event) => go(event, path)}
                    title={formatInZone(row.at, zone)}>{formatRelativeTime(row.at)}</a
                  >
                {:else}
                  <span title={formatInZone(row.at, zone)}>{formatRelativeTime(row.at)}</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="ib-records__wrap">
                {#if row.kind === 'run'}
                  <StatusLabel word={workflowRunStatusWord(row.run.status)} />
                {:else}
                  <Badge variant="warning" data-testid="schedule-missed-row"
                    >{copy.missedOutcome}</Badge
                  >
                  <span class="ib-records__muted">
                    {row.missed.count > 1 ? `${copy.missedCount(row.missed.count)}. ` : ''}{copy
                      .missedReason[row.missed.reason]}
                  </span>
                {/if}
              </Table.Cell>
              <Table.Cell class="ib-records__muted">
                {#if row.kind === 'run' && TERMINAL.has(row.run.status)}
                  {formatDuration(Math.max(0, row.run.updatedAt - row.run.createdAt))}
                {:else}
                  —
                {/if}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table>
    {/if}
  {/if}
</section>
