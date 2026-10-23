<script lang="ts">
  /**
   * One schedule: named by what it does ("Daily summary"), with a sentence that says what it runs
   * and when ("Runs assistant every day at 09:00 · next in 5h"), the start of the text it sends, its
   * next fires, and the runs it launched, each linking to its run. What the engine keeps for itself
   * (the cron expression, jitter, the revision policy, the worker binding, and the run in progress)
   * is under "Engine", closed until it is asked for. The page refreshes the moment a
   * `schedule:fired` or `schedule:missed-fire` event arrives, and "Recent runs" is the engine's own
   * history of the runs the schedule launched (a `scheduleId` filter on `weft.workflows.list`), not
   * only the fires seen since the page opened.
   */
  import {
    Badge,
    Button,
    Collapsible,
    ConfirmDialog,
    DescriptionList,
    Dropdown,
    EmptyState,
    PageHeader,
    Skeleton,
    StatusDot,
    Tooltip,
    VisuallyHidden,
  } from '@lostgradient/cinder';
  import { CircleCheck, CircleX, Copy, Ellipsis, Info, Pause, Pencil, Play } from '@lucide/svelte';

  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { getFleetEventSource } from '../../app/engine-status.svelte.ts';
  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { computeNextFires } from '../../lib/format/cron-preview.ts';
  import { formatDuration, formatRelativeTime, truncateId } from '../../lib/format/index.ts';
  import IdentifierText from '../../lib/identifier-text.svelte';
  import { router, scheduleEditPath, workflowDetailPath } from '../../lib/router.svelte.ts';
  import { kindOf } from '../../lib/schedule-kinds.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import WorkerInheritanceNote from '../../lib/worker-inheritance-note.svelte';
  import { workflowEditPath } from '../../lib/workflow-type-paths.ts';
  import { workflowStatusPresentation } from '../workflows/detail/workflow-status.ts';
  import { cadenceToScheduleValue } from './cadence.ts';
  import { copyScheduleId } from './copy-schedule-id.ts';
  import FaultBanner from './fault-banner.svelte';
  import { OVERLAY_FAILURE } from './overlay-failure.ts';
  import { scheduleOverlayOptions } from './overlay-query.ts';
  import { overlapConsequence } from './overlap-policy.ts';
  import { revisionPolicyLabel } from './revision-policy.ts';
  import { createScheduleActions } from './schedule-actions.svelte.ts';
  import ScheduleNotice from './schedule-notice.svelte';
  import {
    scheduleName,
    scheduleNameIdentifiers,
    scheduleSentence,
  } from './schedule-presentation.ts';
  import {
    fetchScheduleDetail,
    fetchScheduleRunHistory,
    scheduleDetailQueryKey,
    scheduleRunHistoryQueryKey,
  } from './schedule-queries.ts';
  import { scheduleStatusDescriptor } from './schedule-status.ts';
  import ScheduleTarget from './schedule-target.svelte';
  import { actionsOf, type ScheduleTarget as Target } from './schedule-writes.ts';

  interface Props {
    id: string;
  }

  let { id }: Props = $props();

  const client = getClient();
  const principal = getPrincipalStore();
  const queryClient = useQueryClient();
  const fleetSource = getFleetEventSource();

  // `weft.schedules.get` requires `schedules:read`; without it the query never fires.
  const readGate = $derived(scopeGate(principal, ['schedules:read']));

  const detailQuery = createQuery(() => ({
    queryKey: scheduleDetailQueryKey(id),
    queryFn: () => fetchScheduleDetail(client, id),
    enabled: !readGate.disabled,
  }));

  const historyQuery = createQuery(() => ({
    queryKey: scheduleRunHistoryQueryKey(id),
    queryFn: () => fetchScheduleRunHistory(client, id),
  }));

  function invalidateDetail(): void {
    void queryClient.invalidateQueries({ queryKey: scheduleDetailQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: scheduleRunHistoryQueryKey(id) });
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  // A plain `$effect` (not `$derived`) owns the subscription lifecycle
  // deliberately: `$effect`'s cleanup runs BEFORE the next run whenever `id`
  // changes, so the previous schedule's live subscription is always
  // disposed before a new one opens — `$derived` has no equivalent
  // teardown-before-recompute hook, which would leak a subscription per
  // navigation between two schedule detail pages.
  $effect(() => {
    return fleetSource.subscribe((frame) => {
      if (frame.kind !== 'schedule:fired' && frame.kind !== 'schedule:missed-fire') return;
      if (!isRecord(frame.payload) || frame.payload['scheduleId'] !== id) return;
      invalidateDetail();
    });
  });

  const writeGate = $derived(scopeGate(principal, ['schedules:write']));

  // What the Bureau knows of this schedule: whether it starts an agent, or is a workflow's trigger,
  // and the start of the text it sends. Until it answers, the schedule is of no known kind, and
  // nothing is written to it.
  const overlay = createQuery(() => scheduleOverlayOptions(client));

  const actions = createScheduleActions();

  let cancelDialogOpen = $state(false);
  /**
   * What the operator was shown when they asked to cancel, revision included. The page reads the
   * schedule again while the confirmation is open, so cancel sends this snapshot, not the newest
   * read: a schedule that moved on is refused as stale.
   */
  let cancelTarget = $state.raw<Target | null>(null);

  let engineOpen = $state(false);

  function openEdit(): void {
    router.navigate(scheduleEditPath(id));
  }

  function backToList(): void {
    router.navigate('/schedules');
  }

  function openWorkflowEditor(workflowType: string): void {
    router.navigate(workflowEditPath(workflowType));
  }

  function openRun(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<div class="ib-schedule">
  <button type="button" class="ib-schedule__back" onclick={backToList}>
    ← {SCHEDULE_COPY.backToList}
  </button>

  {#if readGate.disabled}
    <EmptyState title="Schedule is locked" description={readGate.title ?? ''}>
      {#snippet action()}
        <Button variant="secondary" onclick={backToList}>{SCHEDULE_COPY.backToList}</Button>
      {/snippet}
    </EmptyState>
  {:else if detailQuery.isPending}
    <div role="status" aria-busy="true" aria-label="Loading schedule">
      <Skeleton height="3.5rem" />
      <Skeleton height="3.5rem" />
    </div>
  {:else if detailQuery.isError}
    <FaultBanner
      treatment={faultTreatment(detailQuery.error)}
      onRetry={() => void detailQuery.refetch()}
    />
  {:else if detailQuery.data === null}
    <EmptyState
      title="Schedule not found"
      description="No schedule with this address exists. It may have been cancelled and purged."
    >
      {#snippet action()}
        <Button variant="secondary" onclick={backToList}>{SCHEDULE_COPY.backToList}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    {@const schedule = detailQuery.data}
    {@const status = scheduleStatusDescriptor(schedule.status)}
    {@const target = { schedule, kind: kindOf(schedule, overlay.data) } satisfies Target}
    {@const allowed = actionsOf(target)}
    {@const name = scheduleName(schedule, target.kind)}
    {@const sentence = scheduleSentence(schedule, target.kind)}
    {@const input = overlay.data?.inputs?.get(schedule.id)}
    {@const nextFires = computeNextFires(cadenceToScheduleValue(schedule), 5)}

    {#if actions.notice !== null}
      <ScheduleNotice notice={actions.notice} onDismiss={actions.dismiss} />
    {/if}
    {#if overlay.data?.failed}
      <FaultBanner treatment={OVERLAY_FAILURE} onRetry={() => void overlay.refetch()} />
    {/if}

    {#snippet heading()}
      <IdentifierText text={name} identifiers={scheduleNameIdentifiers(schedule, target.kind)} />
    {/snippet}
    {#snippet headerActions()}
      {#if allowed.pause || allowed.resume}
        <Button
          variant="secondary"
          disabled={writeGate.disabled || actions.busy}
          title={writeGate.title}
          onclick={() =>
            schedule.status === 'paused'
              ? actions.resume.mutate(target)
              : actions.pause.mutate(target)}
        >
          {#if schedule.status === 'paused'}
            <Play aria-hidden="true" size={14} /> Resume
          {:else}
            <Pause aria-hidden="true" size={14} /> Pause
          {/if}
        </Button>
      {/if}
      {#if allowed.edit}
        <Button variant="secondary" size="md" onclick={openEdit}>
          <Pencil aria-hidden="true" size={14} /> Edit
        </Button>
      {/if}
      {#if allowed.editInWorkflow}
        <Button
          variant="secondary"
          size="md"
          onclick={() => openWorkflowEditor(schedule.workflowType)}
        >
          <Pencil aria-hidden="true" size={14} />
          {SCHEDULE_COPY.editWorkflowAction}
        </Button>
      {/if}
      <Dropdown id="ib-schedule-actions" placement="bottom-end">
        <Dropdown.Trigger caretVisible={false}>
          <Ellipsis aria-hidden="true" size={16} />
          <VisuallyHidden>{SCHEDULE_COPY.moreActions}</VisuallyHidden>
        </Dropdown.Trigger>
        <Dropdown.Menu>
          <Dropdown.Item onclick={() => void copyScheduleId(schedule.id)}>
            <Copy aria-hidden="true" size={14} />
            {SCHEDULE_COPY.copyId}
          </Dropdown.Item>
          {#if allowed.cancel}
            <Dropdown.Item
              variant="danger"
              disabled={writeGate.disabled || actions.busy}
              onclick={() => {
                cancelTarget = target;
                cancelDialogOpen = true;
              }}
            >
              <CircleX aria-hidden="true" size={14} /> Cancel
            </Dropdown.Item>
          {/if}
        </Dropdown.Menu>
      </Dropdown>
    {/snippet}

    <PageHeader
      class="ib-schedule__header"
      headingLevel={1}
      title={heading}
      actions={headerActions}
    />

    <p class="ib-schedule__status" data-testid="schedule-status-line">
      <span>
        {sentence.verb}
        <ScheduleTarget {schedule} kind={target.kind} inSentence />
        {sentence.clause}
      </span>
      {#if schedule.status === 'active' && schedule.nextFireAt !== null}
        <span>· {SCHEDULE_COPY.next(formatRelativeTime(schedule.nextFireAt))}</span>
      {/if}
      {#if schedule.status !== 'active'}
        <Badge variant={status.variant}>{status.label}</Badge>
      {/if}
      {#if schedule.missedFireCount > 0}
        <Badge variant="warning">{SCHEDULE_COPY.missed(schedule.missedFireCount)}</Badge>
      {/if}
    </p>

    {#if input !== undefined}
      <p class="ib-schedule__input" data-testid="schedule-input">
        <span class="ib-schedule__label">{SCHEDULE_COPY.sends}</span> “{input}”
      </p>
    {/if}

    <div class="ib-schedule__block">
      <h2 class="ib-schedule__label">{SCHEDULE_COPY.nextFires}</h2>
      {#if schedule.status === 'active' && nextFires.length > 0}
        <ul class="ib-schedule__fires" data-testid="schedule-next-fires">
          {#each nextFires as fire (fire.id)}
            <li>{fire.label}</li>
          {/each}
        </ul>
      {:else}
        <p class="ib-schedule__muted">{SCHEDULE_COPY.notScheduled(status.label.toLowerCase())}</p>
      {/if}
    </div>

    <div class="ib-schedule__block">
      <h2 class="ib-schedule__label">{SCHEDULE_COPY.recentRuns}</h2>
      {#if historyQuery.isPending}
        <Skeleton height="2.5rem" />
      {:else if historyQuery.isError}
        <FaultBanner
          treatment={faultTreatment(historyQuery.error)}
          onRetry={() => void historyQuery.refetch()}
        />
      {:else if historyQuery.data.items.length === 0}
        <p class="ib-schedule__muted">{SCHEDULE_COPY.noRuns}</p>
      {:else}
        <ul class="ib-schedule__runs" data-testid="schedule-runs">
          {#each historyQuery.data.items as run (run.id)}
            {@const runStatus = workflowStatusPresentation(run.status)}
            {@const runPath = workflowDetailPath(run.id)}
            <li>
              <a
                class="ib-schedule__run"
                href={router.href(runPath)}
                onclick={(event) => openRun(event, runPath)}
              >
                {#if run.status === 'completed'}
                  <CircleCheck class="ib-schedule-glyph" size={14} aria-hidden="true" />
                {:else if run.status === 'failed' || run.status === 'timed-out'}
                  <CircleX class="ib-schedule-glyph" size={14} aria-hidden="true" />
                {/if}
                {formatRelativeTime(run.createdAt)}
                {#if run.status === 'completed' || run.status === 'failed' || run.status === 'timed-out' || run.status === 'cancelled'}
                  · {formatDuration(Math.max(0, run.updatedAt - run.createdAt))}
                {/if}
              </a>
              <Badge variant={runStatus.variant}>{runStatus.label}</Badge>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <p class="ib-schedule__overlap" data-testid="schedule-overlap">
      <Tooltip text={overlapConsequence(schedule.overlap)}>
        <span>
          {SCHEDULE_COPY.overlapLine[schedule.overlap]}
          <Info aria-hidden="true" size={14} />
        </span>
      </Tooltip>
    </p>

    <Collapsible bind:open={engineOpen} trigger={SCHEDULE_COPY.engine} animated={false}>
      <div class="ib-schedule__engine">
        <DescriptionList
          items={[
            {
              term:
                schedule.cronExpression !== undefined
                  ? SCHEDULE_COPY.engineRows.cron
                  : SCHEDULE_COPY.engineRows.interval,
              definition:
                schedule.cronExpression ??
                (schedule.intervalMs !== undefined ? `${schedule.intervalMs}ms` : '—'),
            },
            {
              term: SCHEDULE_COPY.engineRows.jitter,
              definition: schedule.jitterMs ? `±${schedule.jitterMs}ms` : 'None',
            },
            {
              term: SCHEDULE_COPY.engineRows.revisionPolicy,
              definition:
                schedule.revisionPolicy === 'pinned' && schedule.pinnedRevision !== undefined
                  ? `${revisionPolicyLabel(schedule.revisionPolicy)} (${schedule.pinnedRevision})`
                  : revisionPolicyLabel(schedule.revisionPolicy),
            },
          ]}
        />
        <WorkerInheritanceNote surface="schedule" />
        <div>
          <h3 class="ib-schedule__label">{SCHEDULE_COPY.runningNow}</h3>
          {#if schedule.currentWorkflowId !== undefined}
            <a
              class="ib-schedule__run"
              href={router.href(workflowDetailPath(schedule.currentWorkflowId))}
            >
              <StatusDot status="online" labelVisible={false} />
              <code class="ib-identifier">{truncateId(schedule.currentWorkflowId)}</code>
            </a>
          {/if}
          {#if schedule.queuedRuns.length > 0}
            <ul class="ib-schedule__runs" aria-label={SCHEDULE_COPY.queuedRuns}>
              {#each schedule.queuedRuns as queued (queued.workflowId)}
                <li>
                  <a
                    class="ib-schedule__run"
                    href={router.href(workflowDetailPath(queued.workflowId))}
                  >
                    <code class="ib-identifier">{truncateId(queued.workflowId)}</code>
                    queued {formatRelativeTime(queued.queuedAt)}
                  </a>
                </li>
              {/each}
            </ul>
          {/if}
          {#if schedule.currentWorkflowId === undefined && schedule.queuedRuns.length === 0}
            <p class="ib-schedule__muted">{SCHEDULE_COPY.noActiveRuns}</p>
          {/if}
        </div>
      </div>
    </Collapsible>

    <ConfirmDialog
      bind:open={cancelDialogOpen}
      title="Cancel this schedule?"
      description={`“${name}” will stop firing. This can't be undone — create a new schedule to resume this cadence.`}
      confirmLabel="Cancel schedule"
      destructive
      onConfirm={() => {
        if (cancelTarget !== null) actions.cancel.mutate(cancelTarget);
      }}
    />
  {/if}
</div>
