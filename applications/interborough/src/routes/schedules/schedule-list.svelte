<script lang="ts">
  /**
   * `/schedules`: what is set to run, each named by what it does and not by its identifier. A row
   * says what the schedule is called (its description, or what it starts), which agent it runs and
   * how often in words, when it fires next and how the last run ended, and the start of the text it
   * sends. The title and the filters are one bar, and the status and the agent are the address's, so
   * a filtered list can be shared. The identifier is "Copy id" in a row's actions menu. Actions are
   * gated on `schedules:write`.
   */
  import {
    Badge,
    Button,
    ConfirmDialog,
    Dropdown,
    EmptyState,
    PageHeader,
    Select,
    Skeleton,
    VisuallyHidden,
  } from '@lostgradient/cinder';
  import { CalendarClock, CircleX, Copy, Ellipsis, Pause, Pencil, Play } from '@lucide/svelte';

  import type { ScheduleFilter, ScheduleStatus, ScheduleSummary } from '@lostgradient/weft';

  import { createQuery } from '@tanstack/svelte-query';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
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
  import { scheduleStatusDescriptor } from './schedule-status.ts';
  import ScheduleTarget from './schedule-target.svelte';
  import { actionsOf, type ScheduleTarget as Target } from './schedule-writes.ts';

  const client = getClient();
  const principal = getPrincipalStore();

  const SCHEDULE_STATUSES: readonly ScheduleStatus[] = ['active', 'paused', 'cancelled'];

  function isScheduleStatus(value: string | null): value is ScheduleStatus {
    return value !== null && (SCHEDULE_STATUSES as readonly string[]).includes(value);
  }

  /**
   * The URL owns the filters: the status (the dashboard's Schedule health card deep-links here via
   * `/schedules?status=active`) and the agent.
   */
  const statusFilter = $derived<ScheduleStatus | 'all'>(
    isScheduleStatus(router.current.search.get('status'))
      ? (router.current.search.get('status') as ScheduleStatus)
      : 'all',
  );
  const agentFilter = $derived(router.current.search.get('agent') ?? '');

  function setFilter(key: 'status' | 'agent', next: string): void {
    const params = new URLSearchParams(router.current.search);
    if (next === 'all' || next === '') params.delete(key);
    else params.set(key, next);
    const query = params.toString();
    router.navigate(query ? `/schedules?${query}` : '/schedules', { replace: true });
  }

  const filter = $derived<ScheduleFilter>(statusFilter === 'all' ? {} : { status: statusFilter });

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
        ...(agentFilter === '' ? [] : [agentFilter]),
      ]),
    ].toSorted(),
  );
  const statusOptions = [
    { value: 'all', label: SCHEDULE_COPY.anyStatus },
    ...SCHEDULE_STATUSES.map((status) => ({
      value: status,
      label: scheduleStatusDescriptor(status).label,
    })),
  ];
  const agentOptions = $derived([
    { value: 'all', label: SCHEDULE_COPY.anyAgent },
    ...agentNames.map((name) => ({ value: name, label: name })),
  ]);

  const visibleItems = $derived(
    agentFilter === ''
      ? allItems
      : allItems.filter((schedule) => overlay.data?.agents?.get(schedule.id) === agentFilter),
  );

  /** True once a filter narrows the result set: "no schedules yet" and "none match" have different next steps. */
  const isFiltered = $derived(statusFilter !== 'all' || agentFilter !== '');

  const actions = createScheduleActions();

  /** A row's schedule with the service that owns it, as a write needs both. */
  function targetOf(schedule: ScheduleSummary): Target {
    return { schedule, kind: kindOf(schedule, overlay.data) };
  }

  function openCreate(): void {
    router.navigate(scheduleCreatePath());
  }

  function openDetail(event: MouseEvent, id: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(scheduleDetailPath(id));
  }

  function openEdit(id: string): void {
    router.navigate(scheduleEditPath(id));
  }

  /** The editor of the workflow whose file holds a schedule's trigger. */
  function openWorkflowEditor(workflowType: string): void {
    router.navigate(workflowEditPath(workflowType));
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

<section class="ib-schedules" aria-label={SCHEDULE_COPY.title}>
  {#snippet headerActions()}
    <form
      class="ib-schedules__filters"
      aria-label={SCHEDULE_COPY.filtersLabel}
      onsubmit={(event) => event.preventDefault()}
    >
      <Select
        id="ib-schedules-status"
        label={SCHEDULE_COPY.statusLabel}
        labelVisible={false}
        options={statusOptions}
        value={statusFilter}
        onchange={(event) => setFilter('status', event.currentTarget.value)}
      />
      <Select
        id="ib-schedules-agent"
        label={SCHEDULE_COPY.agentLabel}
        labelVisible={false}
        options={agentOptions}
        value={agentFilter === '' ? 'all' : agentFilter}
        onchange={(event) => setFilter('agent', event.currentTarget.value)}
      />
      <Button
        variant="primary"
        size="md"
        disabled={writeGate.disabled}
        title={writeGate.title}
        onclick={openCreate}
      >
        <CalendarClock aria-hidden="true" size={14} />
        {SCHEDULE_COPY.newAction}
      </Button>
    </form>
  {/snippet}

  <PageHeader
    class="ib-schedules__header"
    title={SCHEDULE_COPY.title}
    headingLevel={1}
    actions={headerActions}
  />

  {#if actions.notice !== null}
    <ScheduleNotice notice={actions.notice} onDismiss={actions.dismiss} />
  {/if}

  {#if overlay.data?.failed}
    <FaultBanner treatment={OVERLAY_FAILURE} onRetry={() => void overlay.refetch()} />
  {/if}

  {#if readGate.disabled}
    <EmptyState title="Schedules are locked" description={readGate.title ?? ''} />
  {:else if listQuery.isPending}
    <div role="status" aria-busy="true" aria-label={SCHEDULE_COPY.loading}>
      <Skeleton height="3.5rem" />
      <Skeleton height="3.5rem" />
    </div>
  {:else if listQuery.isError}
    <FaultBanner
      treatment={faultTreatment(listQuery.error)}
      onRetry={() => void listQuery.refetch()}
    />
  {:else if visibleItems.length === 0 && !isFiltered}
    <EmptyState title={SCHEDULE_COPY.empty.title} description={SCHEDULE_COPY.empty.description}>
      {#snippet icon()}
        <CalendarClock aria-hidden="true" size={26} />
      {/snippet}
      {#snippet action()}
        <Button variant="primary" disabled={writeGate.disabled} onclick={openCreate}>
          {SCHEDULE_COPY.newAction}
        </Button>
      {/snippet}
    </EmptyState>
  {:else if visibleItems.length === 0}
    <EmptyState
      title={SCHEDULE_COPY.noMatch.title}
      description={SCHEDULE_COPY.noMatch.description}
    />
  {:else}
    <ul class="ib-schedules__list" aria-label={SCHEDULE_COPY.title}>
      {#each visibleItems as schedule (schedule.id)}
        {@const status = scheduleStatusDescriptor(schedule.status)}
        {@const target = targetOf(schedule)}
        {@const allowed = actionsOf(target)}
        {@const name = scheduleName(schedule, target.kind)}
        {@const input = overlay.data?.inputs?.get(schedule.id)}
        <li
          class="ib-schedule-row"
          data-schedule={schedule.id}
          data-kind={target.kind.kind}
          data-status={schedule.status}
        >
          <div class="ib-schedule-row__body">
            <div class="ib-schedule-row__title">
              <a
                class="ib-schedule-row__name"
                href={router.href(scheduleDetailPath(schedule.id))}
                onclick={(event) => openDetail(event, schedule.id)}
                ><IdentifierText
                  text={name}
                  identifiers={scheduleNameIdentifiers(schedule, target.kind)}
                /></a
              >
              {#if schedule.status !== 'active'}
                <Badge variant={status.variant}>{status.label}</Badge>
              {/if}
              {#if schedule.missedFireCount > 0}
                <Badge variant="warning">{SCHEDULE_COPY.missed(schedule.missedFireCount)}</Badge>
              {/if}
            </div>
            <p class="ib-schedule-row__facts">
              <ScheduleTarget {schedule} kind={target.kind} />
              <span
                ><IdentifierText
                  text={describeCadence(schedule)}
                  identifiers={cadenceIdentifiers(schedule)}
                /></span
              >
              {#if schedule.status === 'active' && schedule.nextFireAt !== null}
                <span>{SCHEDULE_COPY.next(formatRelativeTime(schedule.nextFireAt))}</span>
              {/if}
              <ScheduleLastFire scheduleId={schedule.id} lastFireAt={schedule.lastFireAt} />
            </p>
            {#if input !== undefined}
              <p class="ib-schedule-row__input" data-testid="schedule-input">“{input}”</p>
            {/if}
          </div>
          <Dropdown id={`ib-schedule-actions-${schedule.id}`} placement="bottom-end">
            <Dropdown.Trigger caretVisible={false}>
              <Ellipsis aria-hidden="true" size={16} />
              <VisuallyHidden>{SCHEDULE_COPY.actionsFor(name)}</VisuallyHidden>
            </Dropdown.Trigger>
            <Dropdown.Menu>
              {#if allowed.pause || allowed.resume}
                <Dropdown.Item
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
                <Dropdown.Item disabled={writeGate.disabled} onclick={() => openEdit(schedule.id)}>
                  <Pencil aria-hidden="true" size={14} /> Edit
                </Dropdown.Item>
              {/if}
              {#if allowed.editInWorkflow}
                <Dropdown.Item onclick={() => openWorkflowEditor(schedule.workflowType)}>
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
                  variant="danger"
                  disabled={writeGate.disabled || actions.busy}
                  onclick={() => requestCancel(schedule, name)}
                >
                  <CircleX aria-hidden="true" size={14} /> Cancel
                </Dropdown.Item>
              {/if}
            </Dropdown.Menu>
          </Dropdown>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<ConfirmDialog
  bind:open={cancelDialogOpen}
  title="Cancel this schedule?"
  description={cancelTarget
    ? `“${cancelName}” will stop firing. This can't be undone — create a new schedule to resume this cadence.`
    : ''}
  confirmLabel="Cancel schedule"
  destructive
  onConfirm={confirmCancel}
/>
