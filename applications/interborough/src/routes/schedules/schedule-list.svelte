<script lang="ts">
  /**
   * Schedule list (Track B, plan §9.3; design `Weft UI.dc.html`
   * "Schedule list"): status/cadence/next/last fire, missed-fire count (red
   * when >0), row actions gated on `schedules:write`.
   */
  import {
    Badge,
    Button,
    ConfirmDialog,
    Dropdown,
    EmptyState,
    Input,
    Select,
    Skeleton,
    Table,
  } from '@lostgradient/cinder';
  import {
    CalendarClock,
    CircleX,
    Ellipsis,
    Lock,
    Pause,
    Pencil,
    Play,
    Search,
  } from '@lucide/svelte';

  import type { ScheduleFilter, ScheduleStatus, ScheduleSummary } from '@lostgradient/weft';

  import { createQuery } from '@tanstack/svelte-query';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { queryKeys } from '../../lib/query.ts';
  import {
    router,
    scheduleCreatePath,
    scheduleDetailPath,
    scheduleEditPath,
  } from '../../lib/router.svelte.ts';
  import { kindOf } from '../../lib/schedule-kinds.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import { workflowEditPath } from '../../lib/workflow-type-paths.ts';
  import { describeCadence } from './cadence.ts';
  import FaultBanner from './fault-banner.svelte';
  import { OVERLAY_FAILURE } from './overlay-failure.ts';
  import { scheduleOverlayOptions } from './overlay-query.ts';
  import { createScheduleActions } from './schedule-actions.svelte.ts';
  import ScheduleNotice from './schedule-notice.svelte';
  import { fetchScheduleList } from './schedule-queries.ts';
  import { missedFireBadgeVariant, scheduleStatusDescriptor } from './schedule-status.ts';
  import ScheduleTarget from './schedule-target.svelte';
  import { actionsOf, type ScheduleTarget as Target } from './schedule-writes.ts';

  const client = getClient();
  const principal = getPrincipalStore();

  const SCHEDULE_STATUSES: readonly ScheduleStatus[] = ['active', 'paused', 'cancelled'];

  function isScheduleStatus(value: string | null): value is ScheduleStatus {
    return value !== null && (SCHEDULE_STATUSES as readonly string[]).includes(value);
  }

  /**
   * The URL owns the status filter (plan §4: "URL owns filter/pagination/tab
   * state") — the dashboard's Schedule health card deep-links here via
   * `/schedules?status=active` (plan §9.1: "Cards deep-link to pre-filtered
   * lists"). `workflowTypeFilter`/`idPrefix` stay component-local: nothing
   * deep-links into those today.
   */
  const statusFilter = $derived<ScheduleStatus | 'all'>(
    isScheduleStatus(router.current.search.get('status'))
      ? (router.current.search.get('status') as ScheduleStatus)
      : 'all',
  );

  function setStatusFilter(next: string): void {
    const params = new URLSearchParams(router.current.search);
    if (next === 'all') params.delete('status');
    else params.set('status', next);
    const query = params.toString();
    router.navigate(query ? `/schedules?${query}` : '/schedules', { replace: true });
  }

  let workflowTypeFilter = $state('all');
  let idPrefix = $state('');

  const filter = $derived<ScheduleFilter>({
    ...(statusFilter === 'all' ? {} : { status: statusFilter }),
    ...(workflowTypeFilter === 'all' ? {} : { workflowType: workflowTypeFilter }),
  });

  const readGate = $derived(scopeGate(principal, ['schedules:read']));
  const writeGate = $derived(scopeGate(principal, ['schedules:write']));
  const listQuery = createQuery(() => ({
    queryKey: queryKeys.schedules.list(filter),
    queryFn: () => fetchScheduleList(client, filter),
    enabled: !readGate.disabled,
  }));

  const allItems = $derived(listQuery.data?.items ?? []);

  const workflowTypeOptions = $derived([
    { value: 'all', label: 'All workflow types' },
    ...[...new Set(allItems.map((schedule) => schedule.workflowType))]
      .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((type) => ({ value: type, label: type })),
  ]);

  const visibleItems = $derived(
    allItems.filter(
      (schedule) => idPrefix.trim().length === 0 || schedule.id.startsWith(idPrefix.trim()),
    ),
  );

  /** True once any filter narrows the result set — distinguishes "no schedules configured at all" (onboarding empty state) from "this filter matched nothing" (plan §10.7: every empty state names a next step, but a filtered-empty view's next step is clearing the filter, not creating a schedule that may already exist). */
  const isFiltered = $derived(
    statusFilter !== 'all' || workflowTypeFilter !== 'all' || idPrefix.trim().length > 0,
  );

  // What the Bureau knows of these schedules: which start an agent, and which are a workflow's
  // trigger. Until it answers a schedule is of no known kind, and nothing is written to it.
  const overlay = createQuery(() => scheduleOverlayOptions(client));

  const actions = createScheduleActions();

  /** A row's schedule with the service that owns it, as a write needs both. */
  function targetOf(schedule: ScheduleSummary): Target {
    return { schedule, kind: kindOf(schedule, overlay.data) };
  }

  function openCreate(): void {
    router.navigate(scheduleCreatePath());
  }

  function openDetail(id: string): void {
    router.navigate(scheduleDetailPath(id));
  }

  /**
   * Keyboard-accessible path to the detail view (T9.4 accessibility pass).
   * `Table.Row`'s own `onclick` below is mouse-only — Cinder's `<tr>` gets no
   * `tabindex`/keydown handling (`table-row.svelte` just spreads `...rest`
   * onto a bare element), so before this the entire row was unreachable by
   * keyboard. Mirrors `workflow-table.svelte`'s `onIdLinkClick`: a real
   * anchor carries the keyboard path and modifier-click passthrough (open in
   * new tab, etc.); `stopPropagation` matches this row's own convention for
   * every other nested interactive element (`togglePause`/`openEdit`/
   * `requestCancel`) so the click isn't also seen by the row's `onclick`.
   */
  function onIdLinkClick(event: MouseEvent, id: string): void {
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    openDetail(id);
  }

  function openEdit(id: string, event?: Event): void {
    event?.stopPropagation();
    router.navigate(scheduleEditPath(id));
  }

  /** The editor of the workflow whose file holds a schedule's trigger. */
  function openWorkflowEditor(workflowType: string, event: Event): void {
    event.stopPropagation();
    router.navigate(workflowEditPath(workflowType));
  }

  function togglePause(schedule: ScheduleSummary, event: Event): void {
    event.stopPropagation();
    const target = targetOf(schedule);
    if (schedule.status === 'paused') actions.resume.mutate(target);
    else actions.pause.mutate(target);
  }

  /**
   * Tier-2 confirm before cancel (plan §10.6, T8.2 tier sweep). Previously
   * mutated directly on click with no confirmation at all — a real gap:
   * `../../schedules/schedule-detail.svelte`'s own row-equivalent action
   * already required this exact `ConfirmDialog` ("This can't be undone —
   * create a new schedule to resume this cadence."); the list's row action
   * cancels the same schedule the same irreversible way and needs the same
   * gate.
   */
  let cancelDialogOpen = $state(false);
  /**
   * What the operator was shown when they asked to cancel, revision included. The list reads itself
   * again while the confirmation is open, so confirming looks nothing up: cancel sends this
   * snapshot, and a schedule that moved on is refused as stale instead of a version the operator
   * never saw being cancelled.
   */
  let cancelTarget = $state.raw<Target | null>(null);

  function requestCancel(schedule: ScheduleSummary, event: Event): void {
    event.stopPropagation();
    cancelTarget = targetOf(schedule);
    cancelDialogOpen = true;
  }

  function confirmCancel(): void {
    if (cancelTarget !== null) actions.cancel.mutate(cancelTarget);
    cancelDialogOpen = false;
  }
</script>

<div class="weft-schedule-list">
  <div class="weft-schedule-list__header">
    <div>
      <h1 class="weft-schedule-list__title">Schedules</h1>
      <p class="weft-schedule-list__subtitle">
        {allItems.length} schedule{allItems.length === 1 ? '' : 's'}
      </p>
    </div>
    <div class="weft-schedule-list__header-actions">
      <Button
        variant="primary"
        size="sm"
        disabled={writeGate.disabled}
        onclick={openCreate}
        leadingIcon={plusIcon}
      >
        Create schedule
      </Button>
      {#if writeGate.disabled}
        <span class="weft-schedule-list__scope-pill">
          <Lock aria-hidden="true" size={12} />
          {writeGate.title}
        </span>
      {/if}
    </div>
  </div>

  {#snippet plusIcon()}
    <CalendarClock aria-hidden="true" size={14} />
  {/snippet}

  <div class="weft-schedule-list__filters">
    <Select
      id="weft-schedule-status-filter"
      aria-label="Status"
      value={statusFilter}
      onchange={(event) => setStatusFilter(event.currentTarget.value)}
      options={[
        { value: 'all', label: 'All statuses' },
        { value: 'active', label: 'Active' },
        { value: 'paused', label: 'Paused' },
        { value: 'cancelled', label: 'Cancelled' },
      ]}
    />
    <Select
      id="weft-schedule-type-filter"
      aria-label="Workflow type"
      bind:value={workflowTypeFilter}
      options={workflowTypeOptions}
    />
    <Input
      id="weft-schedule-id-filter"
      label="ID prefix"
      labelVisible={false}
      placeholder="ID prefix…"
      bind:value={idPrefix}
      leading={searchIcon}
    />
  </div>

  {#snippet searchIcon()}
    <Search aria-hidden="true" size={14} />
  {/snippet}

  {#if actions.notice !== null}
    <ScheduleNotice notice={actions.notice} onDismiss={actions.dismiss} />
  {/if}

  {#if overlay.data?.failed}
    <FaultBanner treatment={OVERLAY_FAILURE} onRetry={() => void overlay.refetch()} />
  {/if}

  {#if readGate.disabled}
    <EmptyState title="Schedules are locked" description={readGate.title ?? ''} />
  {:else if listQuery.isPending}
    <div
      class="weft-schedule-list__skeleton"
      role="status"
      aria-busy="true"
      aria-label="Loading schedules"
    >
      {#each Array(6) as _, index (index)}
        <Skeleton height="42px" />
      {/each}
    </div>
  {:else if listQuery.isError}
    <FaultBanner
      treatment={faultTreatment(listQuery.error)}
      onRetry={() => void listQuery.refetch()}
    />
  {:else if visibleItems.length === 0 && !isFiltered}
    <EmptyState title="No schedules" description="Create one to run workflows on a cadence.">
      {#snippet icon()}
        <CalendarClock aria-hidden="true" size={26} />
      {/snippet}
      {#snippet action()}
        <Button variant="primary" size="sm" disabled={writeGate.disabled} onclick={openCreate}>
          Create schedule
        </Button>
      {/snippet}
    </EmptyState>
  {:else if visibleItems.length === 0}
    <EmptyState
      title="No matching schedules"
      description="No schedule matches the current filters. Clear a filter to see more."
    />
  {:else}
    <Table scrollable caption="Schedules">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>Status</Table.HeaderCell>
          <Table.HeaderCell>Schedule ID</Table.HeaderCell>
          <Table.HeaderCell>{SCHEDULE_COPY.startsLabel}</Table.HeaderCell>
          <Table.HeaderCell>Cadence</Table.HeaderCell>
          <Table.HeaderCell>Next fire</Table.HeaderCell>
          <Table.HeaderCell>Last fire</Table.HeaderCell>
          <Table.HeaderCell align="right">Missed</Table.HeaderCell>
          <Table.HeaderCell><span class="weft-sr-only">Actions</span></Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each visibleItems as schedule (schedule.id)}
          {@const status = scheduleStatusDescriptor(schedule.status)}
          {@const target = targetOf(schedule)}
          {@const allowed = actionsOf(target)}
          <Table.Row
            onclick={() => openDetail(schedule.id)}
            class="weft-schedule-list__row"
            data-schedule={schedule.id}
            data-kind={target.kind.kind}
            data-status={schedule.status}
          >
            <Table.Cell as="th">
              <Badge variant={status.variant}>{status.label}</Badge>
            </Table.Cell>
            <Table.Cell class="weft-schedule-list__id">
              <a
                class="weft-schedule-list__id-link"
                href={router.href(scheduleDetailPath(schedule.id))}
                onclick={(event) => onIdLinkClick(event, schedule.id)}
              >
                {schedule.id}
              </a>
              {#if schedule.description !== undefined && schedule.description !== ''}
                <span class="weft-schedule-list__description">{schedule.description}</span>
              {/if}
            </Table.Cell>
            <Table.Cell>
              <ScheduleTarget {schedule} kind={target.kind} stopPropagation />
            </Table.Cell>
            <Table.Cell>{describeCadence(schedule)}</Table.Cell>
            <Table.Cell class="weft-schedule-list__mono">
              {schedule.nextFireAt !== null ? formatRelativeTime(schedule.nextFireAt) : '—'}
            </Table.Cell>
            <Table.Cell class="weft-schedule-list__mono">
              {schedule.lastFireAt !== undefined ? formatRelativeTime(schedule.lastFireAt) : '—'}
            </Table.Cell>
            <Table.Cell align="right">
              <Badge variant={missedFireBadgeVariant(schedule.missedFireCount)}>
                {schedule.missedFireCount}
              </Badge>
            </Table.Cell>
            <Table.Cell align="right">
              <Dropdown id={`weft-schedule-actions-${schedule.id}`} placement="bottom-end">
                <Dropdown.Trigger caretVisible={false} onclick={(event) => event.stopPropagation()}>
                  <Ellipsis aria-hidden="true" size={16} />
                  <span class="weft-sr-only">Actions for {schedule.id}</span>
                </Dropdown.Trigger>
                <Dropdown.Menu>
                  {#if allowed.pause || allowed.resume}
                    <Dropdown.Item
                      disabled={writeGate.disabled || actions.busy}
                      onclick={(event) => togglePause(schedule, event)}
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
                      onclick={(event) => openEdit(schedule.id, event)}
                    >
                      <Pencil aria-hidden="true" size={14} /> Edit
                    </Dropdown.Item>
                  {/if}
                  {#if allowed.editInWorkflow}
                    <Dropdown.Item
                      onclick={(event) => openWorkflowEditor(schedule.workflowType, event)}
                    >
                      <Pencil aria-hidden="true" size={14} />
                      {SCHEDULE_COPY.editWorkflowAction}
                    </Dropdown.Item>
                  {/if}
                  {#if allowed.cancel}
                    <Dropdown.Item
                      variant="danger"
                      disabled={writeGate.disabled || actions.busy}
                      onclick={(event) => requestCancel(schedule, event)}
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
</div>

<ConfirmDialog
  bind:open={cancelDialogOpen}
  title="Cancel this schedule?"
  description={cancelTarget
    ? `"${cancelTarget.schedule.id}" will stop firing. This can't be undone — create a new schedule to resume this cadence.`
    : ''}
  confirmLabel="Cancel schedule"
  destructive
  onConfirm={confirmCancel}
/>

<style>
  .weft-schedule-list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
  }

  .weft-schedule-list__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-3, 0.75rem);
    flex-wrap: wrap;
  }

  .weft-schedule-list__title {
    margin: 0;
    font-size: var(--cinder-text-xl);
    font-weight: 600;
  }

  .weft-schedule-list__subtitle {
    margin: 2px 0 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }

  .weft-schedule-list__header-actions {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2, 0.5rem);
    flex-wrap: wrap;
  }

  .weft-schedule-list__scope-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: var(--cinder-space-2) var(--cinder-space-2);
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
    box-shadow: var(--cinder-shadow-sm);
  }

  .weft-schedule-list__filters {
    display: flex;
    gap: var(--cinder-space-2, 0.5rem);
    flex-wrap: wrap;
    align-items: center;
  }

  .weft-schedule-list__filters > :global(*) {
    min-width: 150px;
  }

  .weft-schedule-list__skeleton {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  :global(.weft-schedule-list__row) {
    cursor: pointer;
  }

  :global(.weft-schedule-list__id) {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
  }

  .weft-schedule-list__id-link {
    color: inherit;
    text-decoration: none;
  }

  .weft-schedule-list__description {
    display: block;
    color: var(--cinder-text-muted);
    font-family: var(--cinder-font-sans, inherit);
    font-size: var(--cinder-text-xs);
  }

  @media (hover: hover) {
    .weft-schedule-list__id-link:hover {
      text-decoration: underline;
    }
  }

  :global(.weft-schedule-list__mono) {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }

  .weft-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
