<script lang="ts">
  /**
   * One schedule (`/schedules/:schedule`): named by what it does ("Daily summary"), with its status
   * word and a sentence that says what it runs and when ("Runs assistant every day at 09:00 in
   * America/Los Angeles"). Under it are the next runs in the zone the schedule is read in with
   * "Skip the next one", the past runs (the runs it started and the fires it missed, from what the
   * engine persisted) and, beside them, the details: the workflow, the input, how it repeats, what
   * happens when a run overlaps, and whether it catches up. The header has the On switch, Run now
   * and Edit. A schedule that is the trigger in a workflow's file is edited in the workflow, and can
   * be switched on and off but not run or skipped from here.
   *
   * The page refreshes the moment a `schedule:fired` or `schedule:missed-fire` event arrives. Every
   * write is made against the revision (or file hash) the page read, and one that was refused for
   * being stale says so and reads the schedule again.
   */
  import {
    Alert,
    Button,
    ConfirmDialog,
    Dropdown,
    EmptyState,
    ErrorState,
    PageHeader,
    Skeleton,
    Toggle,
    VisuallyHidden,
  } from '@lostgradient/cinder';
  import { CircleX, Copy, Ellipsis, Pencil, Play } from '@lucide/svelte';

  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { getFleetEventSource } from '../../app/engine-status.svelte.ts';
  import { RETRY_LABEL, SCHEDULE_COPY } from '../../app/copy.ts';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import IdentifierText from '../../lib/identifier-text.svelte';
  import { router, scheduleEditPath, workflowDetailPath } from '../../lib/router.svelte.ts';
  import { kindOf } from '../../lib/schedule-kinds.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import { scheduleStatusWord } from '../../lib/status.ts';
  import StatusLabel from '../../lib/status-label.svelte';
  import { workflowEditPath } from '../../lib/workflow-type-paths.ts';
  import { copyScheduleId } from './copy-schedule-id.ts';
  import FaultBanner from './fault-banner.svelte';
  import { OVERLAY_FAILURE } from './overlay-failure.ts';
  import { scheduleOverlayOptions } from './overlay-query.ts';
  import { createScheduleActions } from './schedule-actions.svelte.ts';
  import ScheduleNextRuns from './schedule-next-runs.svelte';
  import ScheduleNotice from './schedule-notice.svelte';
  import SchedulePastRuns from './schedule-past-runs.svelte';
  import {
    cadenceIdentifiers,
    scheduleName,
    scheduleNameIdentifiers,
    scheduleSentence,
  } from './schedule-presentation.ts';
  import {
    fetchScheduleDetail,
    scheduleDetailQueryKey,
    scheduleMissedQueryKey,
    scheduleRunHistoryQueryKey,
  } from './schedule-queries.ts';
  import ScheduleRail from './schedule-rail.svelte';
  import ScheduleTarget from './schedule-target.svelte';
  import { scheduleZone, sentenceZone } from './schedule-time.ts';
  import { actionsOf, type ScheduleTarget as Target } from './schedule-writes.ts';

  interface Props {
    id: string;
  }

  let { id }: Props = $props();

  const copy = SCHEDULE_COPY.detail;
  const client = getClient();
  const principal = getPrincipalStore();
  const queryClient = useQueryClient();
  const fleetSource = getFleetEventSource();

  // `weft.schedules.get` requires `schedules:read`; without it the query never fires.
  const readGate = $derived(scopeGate(principal, ['schedules:read']));
  const writeGate = $derived(scopeGate(principal, ['schedules:write']));

  const detailQuery = createQuery(() => ({
    queryKey: scheduleDetailQueryKey(id),
    queryFn: () => fetchScheduleDetail(client, id),
    enabled: !readGate.disabled,
  }));

  function invalidateDetail(): void {
    void queryClient.invalidateQueries({ queryKey: scheduleDetailQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: scheduleRunHistoryQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: scheduleMissedQueryKey(id) });
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  // A plain `$effect` owns the subscription: its cleanup runs before the next run whenever `id`
  // changes, so the previous schedule's subscription is disposed before a new one opens.
  $effect(() => {
    return fleetSource.subscribe((frame) => {
      if (frame.kind !== 'schedule:fired' && frame.kind !== 'schedule:missed-fire') return;
      if (!isRecord(frame.payload) || frame.payload['scheduleId'] !== id) return;
      invalidateDetail();
    });
  });

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

  /**
   * The switch writes, and Cinder's Toggle passes no `data-*` attribute on to its button, so the
   * page marks the button itself: the shell holds a marked control while the server does not answer.
   * The spread on the component is what the guard reads (`changing-controls.guard.test.ts`).
   */
  let switchHost = $state<HTMLElement>();
  $effect(() => {
    switchHost?.querySelector('[role="switch"]')?.setAttribute('data-changes', '');
  });

  function backToList(): void {
    router.navigate('/schedules');
  }

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="ib-records ib-schedule" aria-label={SCHEDULE_COPY.title} data-page="schedule">
  {#if readGate.disabled}
    <EmptyState kind="first-use" title={copy.locked.title} description={readGate.title ?? ''}>
      {#snippet action()}
        <Button variant="secondary" onclick={backToList}>{SCHEDULE_COPY.backToList}</Button>
      {/snippet}
    </EmptyState>
  {:else if detailQuery.isPending}
    <div role="status" aria-busy="true" aria-label={copy.loading}>
      <Skeleton height="3.5rem" />
      <Skeleton height="3.5rem" />
    </div>
  {:else if detailQuery.isError}
    <ErrorState
      variant="flat"
      title={copy.loadFailed}
      description={faultTreatment(detailQuery.error).message}
      headingLevel={1}
      retryLabel={RETRY_LABEL}
      onRetry={() => void detailQuery.refetch()}
    />
  {:else if detailQuery.data === null}
    <EmptyState
      kind="first-use"
      title={copy.notFound.title}
      description={copy.notFound.description}
      headingLevel={1}
    >
      {#snippet action()}
        <Button variant="secondary" onclick={backToList}>{SCHEDULE_COPY.backToList}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    {@const schedule = detailQuery.data}
    {@const target = { schedule, kind: kindOf(schedule, overlay.data) } satisfies Target}
    {@const allowed = actionsOf(target)}
    {@const name = scheduleName(schedule, target.kind)}
    {@const sentence = scheduleSentence(schedule, target.kind)}
    {@const zone = sentenceZone(schedule)}
    {@const input = overlay.data?.inputs?.get(schedule.id)}
    {@const switchable = allowed.pause || allowed.resume}

    {#if actions.notice !== null}
      <ScheduleNotice notice={actions.notice} onDismiss={actions.dismiss} />
    {/if}
    {#if actions.runNowResult !== null && actions.runNowResult.scheduleId === schedule.id}
      {@const result = actions.runNowResult}
      <Alert
        variant={result.outcome === 'skipped' ? 'warning' : 'success'}
        dismissible
        onDismiss={actions.dismissRunNow}
        data-testid="schedule-run-now"
        data-outcome={result.outcome}
      >
        <p class="ib-schedule__alert">{copy.runNowOutcome[result.outcome]}</p>
        {#if result.outcome !== 'skipped'}
          {@const path = workflowDetailPath(result.runId)}
          <a href={router.href(path)} onclick={(event) => go(event, path)}
            >{copy.runNowOutcome.viewRun}</a
          >
        {/if}
      </Alert>
    {/if}
    {#if overlay.data?.failed}
      <FaultBanner treatment={OVERLAY_FAILURE} onRetry={() => void overlay.refetch()} />
    {/if}

    {#snippet heading()}
      <IdentifierText text={name} identifiers={scheduleNameIdentifiers(schedule, target.kind)} />
    {/snippet}
    {#snippet headerActions()}
      {#if switchable}
        <span class="ib-schedule__switch" bind:this={switchHost}>
          <Toggle
            {...{ 'data-changes': true }}
            id="ib-schedule-on"
            label={copy.onSwitch}
            checked={schedule.status === 'active'}
            disabled={writeGate.disabled || actions.busy}
            onValueChangeRequest={() => {
              if (schedule.status === 'paused') actions.resume.mutate(target);
              else actions.pause.mutate(target);
              // The switch follows the schedule once the page has read it again, not the click.
              return schedule.status === 'active';
            }}
          />
        </span>
      {/if}
      {#if allowed.runNow}
        <Button
          data-changes
          variant="secondary"
          size="sm"
          disabled={writeGate.disabled || actions.busy}
          title={writeGate.title}
          onclick={() => actions.runNow.mutate(target)}
        >
          <Play aria-hidden="true" size={14} />
          {copy.runNow}
        </Button>
      {/if}
      {#if allowed.edit}
        <Button
          variant="secondary"
          size="sm"
          disabled={writeGate.disabled}
          title={writeGate.title}
          onclick={() => router.navigate(scheduleEditPath(schedule.id))}
        >
          <Pencil aria-hidden="true" size={14} />
          {copy.edit}
        </Button>
      {/if}
      {#if allowed.editInWorkflow}
        <Button
          variant="secondary"
          size="sm"
          href={router.href(workflowEditPath(schedule.workflowType))}
          onclick={(event) => go(event, workflowEditPath(schedule.workflowType))}
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
              data-changes
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

    <PageHeader headingLevel={1} title={heading} actions={headerActions} />

    <p class="ib-schedule__sentence" data-testid="schedule-status-line">
      <StatusLabel word={scheduleStatusWord(schedule.status)} />
      <span>
        {sentence.verb}
        <ScheduleTarget {schedule} kind={target.kind} inSentence />
        <IdentifierText text={sentence.clause} identifiers={cadenceIdentifiers(schedule)} />
        {#if zone !== null}{SCHEDULE_COPY.inZone(zone)}{/if}
      </span>
      {#if schedule.missedFireCount > 0}
        <span class="ib-records__muted" data-testid="schedule-missed-count">
          {SCHEDULE_COPY.missed(schedule.missedFireCount)}{schedule.lastMissedFireAt !== undefined
            ? `, ${SCHEDULE_COPY.lastMissed(formatRelativeTime(schedule.lastMissedFireAt))}`
            : ''}
        </span>
      {/if}
    </p>

    <div class="ib-schedule__layout">
      <div class="ib-schedule__main">
        <ScheduleNextRuns
          {schedule}
          canSkip={allowed.skipNext && !writeGate.disabled}
          busy={actions.busy}
          onSkip={(occurrence) => actions.skipNext.mutate({ target, occurrence })}
        />
        <SchedulePastRuns {schedule} zone={scheduleZone(schedule)} />
      </div>
      <ScheduleRail {schedule} kind={target.kind} {input} />
    </div>

    <ConfirmDialog
      bind:open={cancelDialogOpen}
      title={SCHEDULE_COPY.cancelDialog.title}
      description={SCHEDULE_COPY.cancelDialog.description(name)}
      confirmLabel={SCHEDULE_COPY.cancelDialog.confirm}
      destructive
      onConfirm={() => {
        if (cancelTarget !== null) actions.cancel.mutate(cancelTarget);
      }}
    />
  {/if}
</section>
