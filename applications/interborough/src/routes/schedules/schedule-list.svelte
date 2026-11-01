<script lang="ts">
  /**
   * `/schedules`: every schedule as a table, whichever way it was made: the Bureau's schedules that
   * run an agent, the engine's that start a workflow defined in code, and the trigger in an
   * agent-authored workflow's file. A row says what the schedule is called (its description, or what
   * it starts), the workflow it runs (an agent, or the workflow with the kind it is), how often in
   * words with the zone a cron is read in, when it fires next, how the last run ended, and one of
   * the seven status words. The status and the agent are the address's, so a filtered list can be
   * shared. The identifier is "Copy ID" in a row's actions menu. Actions are gated on
   * `schedules:write`, and cancelling asks first with the revision of the schedule the row showed.
   *
   * Whether there is nothing to list, or the server is failing or refusing, is the view frame's to
   * say (`app/view-probes.ts`).
   */
  import {
    Badge,
    Button,
    ConfirmDialog,
    Dropdown,
    EmptyState,
    FilterBar,
    PageHeader,
    Skeleton,
    Table,
    VisuallyHidden,
  } from '@lostgradient/cinder';
  import { CalendarClock, CircleX, Copy, Ellipsis, Pause, Pencil, Play } from '@lucide/svelte';

  import type { ScheduleFilter, ScheduleStatus, ScheduleSummary } from '@lostgradient/weft';

  import { createQuery } from '@tanstack/svelte-query';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import RecordsToolbar from '../../app/records/records-toolbar.svelte';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import IdentifierText from '../../lib/identifier-text.svelte';
  import { queryKeys } from '../../lib/query.ts';
  import {
    router,
    scheduleCreatePath,
    scheduleDetailPath,
    scheduleEditPath,
  } from '../../lib/router.svelte.ts';
  import { kindOf } from '../../lib/schedule-kinds.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import { scheduleStatusWord } from '../../lib/status.ts';
  import StatusLabel from '../../lib/status-label.svelte';
  import { workflowEditPath } from '../../lib/workflow-type-paths.ts';
  import { describeCadence } from './cadence.ts';
  import { copyScheduleId } from './copy-schedule-id.ts';
  import FaultBanner from './fault-banner.svelte';
  import { OVERLAY_FAILURE } from './overlay-failure.ts';
  import { scheduleOverlayOptions } from './overlay-query.ts';
  import { createScheduleActions } from './schedule-actions.svelte.ts';
  import ScheduleLastFire from './schedule-last-fire.svelte';
  import ScheduleNotice from './schedule-notice.svelte';
  import {
    cadenceIdentifiers,
    scheduleName,
    scheduleNameIdentifiers,
  } from './schedule-presentation.ts';
  import { fetchScheduleList } from './schedule-queries.ts';
  import ScheduleTarget from './schedule-target.svelte';
  import { formatInZone, scheduleZone, sentenceZone } from './schedule-time.ts';
  import { actionsOf, type ScheduleTarget as Target } from './schedule-writes.ts';

  const client = getClient();
  const principal = getPrincipalStore();

  const SCHEDULE_STATUSES: readonly ScheduleStatus[] = ['active', 'paused', 'cancelled'];

  /**
   * The URL owns the filters: the status (the Health overview's Schedules count deep-links here via
   * `/schedules?status=active`) and the agent.
   */
  const statusFilter = $derived<ScheduleStatus | undefined>(
    SCHEDULE_STATUSES.find((status) => status === router.current.search.get('status')),
  );
  const agentFilter = $derived(router.current.search.get('agent') ?? undefined);

  function changeFilter(key: string, value: string): void {
    const params = new URLSearchParams(router.current.search);
    if (value === '' || value === 'all') params.delete(key);
    else params.set(key, value);
    const query = params.toString();
    router.navigate(query ? `/schedules?${query}` : '/schedules', { replace: true });
  }

  function clearFilters(): void {
    router.navigate('/schedules', { replace: true });
  }

  const filter = $derived<ScheduleFilter>(
    statusFilter === undefined ? {} : { status: statusFilter },
  );

  const readGate = $derived(scopeGate(principal, ['schedules:read']));
  const writeGate = $derived(scopeGate(principal, ['schedules:write']));
  const listQuery = createQuery(() => ({
    queryKey: queryKeys.schedules.list(filter),
    queryFn: () => fetchScheduleList(client, filter),
    enabled: !readGate.disabled,
  }));

  // What the Bureau knows of these schedules: which start an agent, which agent, and the start of
  // what they send. Until it answers a schedule is of no known kind, and nothing is written to it.
  const overlay = createQuery(() => scheduleOverlayOptions(client));

  const allItems = $derived(listQuery.data?.items ?? []);

  const agentNames = $derived(
    [
      ...new Set([
        ...(overlay.data?.agents?.values() ?? []),
        ...(agentFilter === undefined ? [] : [agentFilter]),
      ]),
    ].toSorted(),
  );
  const facets = $derived([
    {
      type: 'select' as const,
      key: 'status',
      label: SCHEDULE_COPY.statusLabel,
      placeholder: SCHEDULE_COPY.anyStatus,
      options: SCHEDULE_STATUSES.map((status) => ({
        value: status,
        label: scheduleStatusWord(status),
      })),
    },
    {
      type: 'select' as const,
      key: 'agent',
      label: SCHEDULE_COPY.agentLabel,
      placeholder: SCHEDULE_COPY.anyAgent,
      options: agentNames.map((name) => ({ value: name, label: name })),
    },
  ]);
  const appliedFilters = $derived([
    ...(statusFilter === undefined
      ? []
      : [
          {
            key: 'status',
            value: statusFilter,
            label: SCHEDULE_COPY.statusLabel,
          },
        ]),
    ...(agentFilter === undefined
      ? []
      : [
          {
            key: 'agent',
            value: agentFilter,
            label: SCHEDULE_COPY.agentLabel,
          },
        ]),
  ]);

  const visibleItems = $derived(
    agentFilter === undefined
      ? allItems
      : allItems.filter((schedule) => overlay.data?.agents?.get(schedule.id) === agentFilter),
  );

  const actions = createScheduleActions();

  /** A row's schedule with the service that owns it, as a write needs both. */
  function targetOf(schedule: ScheduleSummary): Target {
    return { schedule, kind: kindOf(schedule, overlay.data) };
  }

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  function togglePause(schedule: ScheduleSummary): void {
    const target = targetOf(schedule);
    if (schedule.status === 'paused') actions.resume.mutate(target);
    else actions.pause.mutate(target);
  }

  let cancelDialogOpen = $state(false);
  /**
   * What the operator was shown when they asked to cancel, revision included. The list reads itself
   * again while the confirmation is open, so confirming looks nothing up: cancel sends this
   * snapshot, and a schedule that moved on is refused as stale instead of a version the operator
   * never saw being cancelled.
   */
  let cancelTarget = $state.raw<Target | null>(null);
  /** The name the operator was shown, which the confirmation uses to say which schedule it is. */
  let cancelName = $state('');

  function requestCancel(schedule: ScheduleSummary, name: string): void {
    cancelTarget = targetOf(schedule);
    cancelName = name;
    cancelDialogOpen = true;
  }

  function confirmCancel(): void {
    if (cancelTarget !== null) actions.cancel.mutate(cancelTarget);
    cancelDialogOpen = false;
  }
</script>

<section class="ib-records" aria-label={SCHEDULE_COPY.title} data-page="schedules">
  <PageHeader title={SCHEDULE_COPY.title} headingLevel={1} />

  {#snippet filterBar()}
    <FilterBar
      aria-label={SCHEDULE_COPY.filtersLabel}
      searchVisible={false}
      {facets}
      {appliedFilters}
      onFacetChange={changeFilter}
      onFilterRemove={(key) => changeFilter(key, '')}
      onClearAll={clearFilters}
    />
  {/snippet}
  {#snippet newSchedule()}
    <Button
      variant="primary"
      size="sm"
      disabled={writeGate.disabled}
      title={writeGate.title}
      onclick={() => router.navigate(scheduleCreatePath())}
    >
      <CalendarClock aria-hidden="true" size={14} />
      {SCHEDULE_COPY.newAction}
    </Button>
  {/snippet}
  <RecordsToolbar
    count={SCHEDULE_COPY.count(visibleItems.length)}
    filters={filterBar}
    action={newSchedule}
  />

  {#if actions.notice !== null}
    <ScheduleNotice notice={actions.notice} onDismiss={actions.dismiss} />
  {/if}

  {#if overlay.data?.failed}
    <FaultBanner treatment={OVERLAY_FAILURE} onRetry={() => void overlay.refetch()} />
  {/if}

  {#if listQuery.isPending}
    <div role="status" aria-busy="true" aria-label={SCHEDULE_COPY.loading}>
      <Skeleton height="3.5rem" />
      <Skeleton height="3.5rem" />
    </div>
  {:else if listQuery.isError}
    <FaultBanner
      treatment={faultTreatment(listQuery.error)}
      onRetry={() => void listQuery.refetch()}
    />
  {:else if visibleItems.length === 0}
    <EmptyState
      kind="filtered"
      title={SCHEDULE_COPY.noMatch.title}
      description={SCHEDULE_COPY.noMatch.description}
      headingLevel={2}
      clearFiltersLabel={SCHEDULE_COPY.clearFilters}
      onClearFilters={clearFilters}
    />
  {:else}
    <Table caption={SCHEDULE_COPY.caption} density="condensed">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{SCHEDULE_COPY.columns.schedule}</Table.HeaderCell>
          <Table.HeaderCell>{SCHEDULE_COPY.columns.runs}</Table.HeaderCell>
          <Table.HeaderCell>{SCHEDULE_COPY.columns.repeats}</Table.HeaderCell>
          <Table.HeaderCell>{SCHEDULE_COPY.columns.next}</Table.HeaderCell>
          <Table.HeaderCell>{SCHEDULE_COPY.columns.last}</Table.HeaderCell>
          <Table.HeaderCell>{SCHEDULE_COPY.columns.status}</Table.HeaderCell>
          <Table.HeaderCell
            ><VisuallyHidden>{SCHEDULE_COPY.columns.actions}</VisuallyHidden></Table.HeaderCell
          >
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each visibleItems as schedule (schedule.id)}
          {@const target = targetOf(schedule)}
          {@const allowed = actionsOf(target)}
          {@const name = scheduleName(schedule, target.kind)}
          {@const zone = sentenceZone(schedule)}
          {@const input = overlay.data?.inputs?.get(schedule.id)}
          <Table.Row
            data-schedule={schedule.id}
            data-kind={target.kind.kind}
            data-status={schedule.status}
            data-status-word={scheduleStatusWord(schedule.status)}
          >
            <Table.Cell class="ib-records__wrap">
              <a
                href={router.href(scheduleDetailPath(schedule.id))}
                onclick={(event) => go(event, scheduleDetailPath(schedule.id))}
                ><IdentifierText
                  text={name}
                  identifiers={scheduleNameIdentifiers(schedule, target.kind)}
                /></a
              >
              {#if schedule.missedFireCount > 0}
                <Badge variant="warning">{SCHEDULE_COPY.missed(schedule.missedFireCount)}</Badge>
              {/if}
              {#if input !== undefined}
                <p class="ib-schedule__input" data-testid="schedule-input">{`“${input}”`}</p>
              {/if}
            </Table.Cell>
            <Table.Cell class="ib-records__wrap">
              <ScheduleTarget {schedule} kind={target.kind} />
            </Table.Cell>
            <Table.Cell class="ib-records__wrap">
              <IdentifierText
                text={describeCadence(schedule)}
                identifiers={cadenceIdentifiers(schedule)}
              />
              {#if zone !== null}
                <span class="ib-records__muted">{SCHEDULE_COPY.inZone(zone)}</span>
              {/if}
            </Table.Cell>
            <Table.Cell class="ib-records__muted">
              {#if schedule.status === 'active' && schedule.nextFireAt !== null}
                <span title={formatInZone(schedule.nextFireAt, scheduleZone(schedule))}
                  >{formatRelativeTime(schedule.nextFireAt)}</span
                >
              {/if}
            </Table.Cell>
            <Table.Cell class="ib-records__muted">
              <ScheduleLastFire scheduleId={schedule.id} lastFireAt={schedule.lastFireAt} />
            </Table.Cell>
            <Table.Cell>
              <StatusLabel word={scheduleStatusWord(schedule.status)} />
            </Table.Cell>
            <Table.Cell align="right">
              <Dropdown id={`ib-schedule-actions-${schedule.id}`} placement="bottom-end">
                <Dropdown.Trigger caretVisible={false}>
                  <Ellipsis aria-hidden="true" size={16} />
                  <VisuallyHidden>{SCHEDULE_COPY.actionsFor(name)}</VisuallyHidden>
                </Dropdown.Trigger>
                <Dropdown.Menu>
                  {#if allowed.pause || allowed.resume}
                    <Dropdown.Item
                      data-changes
                      disabled={writeGate.disabled || actions.busy}
                      onclick={() => togglePause(schedule)}
                    >
                      {#if schedule.status === 'paused'}
                        <Play aria-hidden="true" size={14} /> Resume
                      {:else}
                        <Pause aria-hidden="true" size={14} /> Pause
                      {/if}
                    </Dropdown.Item>
                  {/if}
                  {#if allowed.edit}
                    <Dropdown.Item
                      disabled={writeGate.disabled}
                      onclick={() => router.navigate(scheduleEditPath(schedule.id))}
                    >
                      <Pencil aria-hidden="true" size={14} /> Edit
                    </Dropdown.Item>
                  {/if}
                  {#if allowed.editInWorkflow}
                    <Dropdown.Item
                      onclick={() => router.navigate(workflowEditPath(schedule.workflowType))}
                    >
                      <Pencil aria-hidden="true" size={14} />
                      {SCHEDULE_COPY.editWorkflowAction}
                    </Dropdown.Item>
                  {/if}
                  <Dropdown.Item onclick={() => void copyScheduleId(schedule.id)}>
                    <Copy aria-hidden="true" size={14} />
                    {SCHEDULE_COPY.copyId}
                  </Dropdown.Item>
                  {#if allowed.cancel}
                    <Dropdown.Item
                      data-changes
                      variant="danger"
                      disabled={writeGate.disabled || actions.busy}
                      onclick={() => requestCancel(schedule, name)}
                    >
                      <CircleX aria-hidden="true" size={14} /> Cancel
                    </Dropdown.Item>
                  {/if}
                </Dropdown.Menu>
              </Dropdown>
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
  {/if}
</section>

<ConfirmDialog
  bind:open={cancelDialogOpen}
  title={SCHEDULE_COPY.cancelDialog.title}
  description={cancelTarget ? SCHEDULE_COPY.cancelDialog.description(cancelName) : ''}
  confirmLabel={SCHEDULE_COPY.cancelDialog.confirm}
  destructive
  onConfirm={confirmCancel}
/>
