<script lang="ts">
  /**
   * One schedule (`/schedules/:schedule`; COR-2018, the heading, its actions and the details card
   * of `ScheduleDetail`): named by what it does ("Daily summary"), with the Active switch and its
   * one status word ("Missed runs, 4", "Paused") beside the name, and the sentence that says what
   * it runs and when ("Runs Chat with an agent with Assistant every day at 3:00 AM (9:00 AM
   * UTC)."), then the line that says when it runs next and when it last ran. Under them are its
   * runs, and beside them the details card: what runs, its input, when, and how it behaves.
   *
   * The heading's actions are Edit, Run now and a menu that holds Delete schedule. A schedule that
   * is the trigger in a workflow file whose values it fixes is changed in the file, so it offers
   * Open file and Run now and nothing else, with a chip under the sentence that names the file. Run now is off, with its reason as its description,
   * while the workflow cannot load or a model agent has no provider; Pause and resume are the
   * Active switch's alone.
   *
   * While a run of the schedule is going the status reads Running, the summary line leads with
   * "Running now: started 38 seconds ago" and a link to the run, and Run now says beside it that it
   * would start a second one; the schedule itself is still Active.
   *
   * The page refreshes the moment a `schedule:fired` or `schedule:missed-fire` event arrives. Every
   * write is made against the revision (or file hash) the page read, and one that was refused for
   * being stale says so and reads the schedule again.
   */
  import {
    Button,
    ConfirmDialog,
    Divider,
    Dropdown,
    EmptyState,
    ErrorState,
    formatTimeZoneLabel,
    Link,
    PageHeader,
    Skeleton,
    StatusDot,
    Toggle,
    VisuallyHidden,
  } from '@lostgradient/cinder';
  import { Ellipsis, ExternalLink, Pencil, Play, Trash2 } from '@lucide/svelte';

  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { usePageLabel } from '../../app/breadcrumbs.svelte.ts';
  import { RETRY_LABEL, SCHEDULE_COPY } from '../../app/copy.ts';
  import { getConnection } from '../../app/connection.svelte.ts';
  import { getFleetEventSource } from '../../app/engine-status.svelte.ts';
  import NotFoundState from '../../app/not-found-state.svelte';
  import { showFault, showToast } from '../../app/toast-host.svelte';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import IdentifierText from '../../lib/identifier-text.svelte';
  import {
    router,
    scheduleDetailPath,
    scheduleEditPath,
    workflowDetailPath,
  } from '../../lib/router.svelte.ts';
  import { AGENT_RUN_TYPE, kindOf } from '../../lib/schedule-kinds.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import { getWorkflowFile, resumeWorkflowFile } from '../../lib/workflow-files.ts';
  import {
    internalWorkflowsPath,
    workflowEditPath,
    workflowTypePath,
  } from '../../lib/workflow-type-paths.ts';
  import FaultBanner from './fault-banner.svelte';
  import { OVERLAY_FAILURE } from './overlay-failure.ts';
  import { useScheduleOverlay } from './overlay-query.svelte.ts';
  import { createScheduleActions } from './schedule-actions.svelte.ts';
  import ScheduleDetailsCard from './schedule-details-card.svelte';
  import ScheduleFileChip from './schedule-file-chip.svelte';
  import {
    isFileDefined,
    nextSummary,
    startedAgo,
    jsonProblemLine,
    problemLocation,
    runNowOffReason,
    scheduleInput,
    sentenceCadence,
  } from './schedule-detail-model.ts';
  import ScheduleBlockers from './schedule-blockers.svelte';
  import ScheduleLastFire from './schedule-last-fire.svelte';
  import ScheduleNotice from './schedule-notice.svelte';
  import ScheduleRuns from './schedule-runs.svelte';
  import { cadenceIdentifiers, scheduleNameIdentifiers } from './schedule-presentation.ts';
  import {
    fetchScheduleDetail,
    fetchScheduleRunHistory,
    scheduleDetailQueryKey,
    scheduleMissedQueryKey,
    scheduleRunHistoryQueryKey,
  } from './schedule-queries.ts';
  import { createScheduleRowQueries } from './schedule-row-queries.svelte.ts';
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
  const connection = getConnection();

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
  const overlay = useScheduleOverlay(client, connection);

  const schedule = $derived(detailQuery.data ?? null);
  // The runs the schedule launched, which the Runs list and the last-run words read from the same
  // cache entry: the newest one that is going says so in the heading and the summary line.
  const runHistory = createQuery(() => ({
    queryKey: scheduleRunHistoryQueryKey(id),
    queryFn: () => fetchScheduleRunHistory(client, id),
    enabled: !readGate.disabled,
    retry: false,
  }));
  const goingRun = $derived(runHistory.data?.items.find((run) => run.status === 'running'));
  // The clock the next run is counted from, read again whenever the schedule is.
  const now = $derived.by(() => {
    void detailQuery.dataUpdatedAt;
    return Date.now();
  });
  // The row the list shows for this schedule: its name, its one status word, why it will not start.
  const rowQueries = createScheduleRowQueries({
    schedules: () => (schedule === null ? [] : [schedule]),
    overlay: () => overlay.data,
    now: () => now,
  });
  const row = $derived(schedule === null ? undefined : rowQueries.rows[0]);
  const target = $derived(
    schedule === null
      ? undefined
      : ({ schedule, kind: kindOf(schedule, overlay.data) } satisfies Target),
  );
  const name = $derived(row?.title ?? '');

  // The blocker card says which line of the workflow's file stopped it parsing, so the file's text is
  // read, only for a schedule whose workflow cannot load.
  const brokenType = $derived(
    row?.allBlockers.find((blocker) => blocker.kind === 'cannot-load')?.workflowType,
  );
  const brokenFile = createQuery(() => ({
    queryKey: ['schedules', 'workflow-file-text', brokenType ?? ''],
    queryFn: () => getWorkflowFile(brokenType ?? ''),
    enabled: brokenType !== undefined,
    retry: false,
  }));
  const brokenLine = $derived(
    brokenFile.data?.text == null ? undefined : jsonProblemLine(brokenFile.data.text),
  );

  // The breadcrumb names the schedule while this page is open, not the identifier in the address.
  usePageLabel(() => ({ path: scheduleDetailPath(id), label: row?.title }));

  const actions = createScheduleActions({
    onRunNow(outcome) {
      if (outcome.outcome === 'skipped') {
        showToast(copy.runNowOutcome.skipped, { variant: 'warning' });
        return;
      }
      const path = workflowDetailPath(outcome.runId);
      showToast(
        outcome.outcome === 'queued' ? copy.runNowOutcome.queued : copy.runNowStarted(name),
        {
          variant: 'success',
          showIcon: true,
          action: { label: copy.openRun, onAction: () => router.navigate(path) },
        },
      );
    },
  });

  /** Resumes the workflow whose file is paused, which a paused schedule on it is waiting for. */
  const resumeWorkflow = createMutation(() => ({
    mutationFn: (file: { readonly id: string; readonly hash: string }) =>
      resumeWorkflowFile(file.id, file.hash),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['schedules'] }),
    onError: (error: unknown) =>
      showFault({
        ...faultTreatment(error),
        message: `${copy.workflowPaused.failed}. ${faultTreatment(error).message}`,
      }),
  }));

  let deleteDialogOpen = $state(false);
  /**
   * What the operator was shown when they asked to delete, revision included. The page reads the
   * schedule again while the confirmation is open, so delete sends this snapshot, not the newest
   * read: a schedule that moved on is refused as stale.
   */
  let deleteTarget = $state.raw<Target | null>(null);

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
</script>

<section
  class="ib-records ib-schedule"
  aria-label={SCHEDULE_COPY.title}
  data-page="schedule"
  {@attach followLinks}
>
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
  {:else if schedule === null || target === undefined || row === undefined}
    <NotFoundState
      title={copy.notFound.title}
      description={copy.notFound.description}
      view="schedules"
    />
  {:else}
    {@const allowed = actionsOf(target)}
    {@const kind = target.kind}
    {@const file = overlay.data?.files?.get(schedule.workflowType)}
    {@const fileDefined = kind.kind === 'workflow-file' && isFileDefined(kind.file)}
    {@const input = scheduleInput(schedule, overlay.data?.inputs?.get(schedule.id), file)}
    {@const switchWritable = !fileDefined && (allowed.pause || allowed.resume)}
    {@const switchable = switchWritable || kind.kind === 'workflow-file'}
    {@const runNowReason = runNowOffReason(row)}
    {@const going = row.statusKey === 'active' ? goingRun : undefined}
    {@const statusWord = going === undefined ? row.statusWord : 'Running'}
    {@const workflowPaused = row.status === 'paused' && file?.paused === true}
    {@const writable = !writeGate.disabled && !actions.busy}
    {@const agentNames = fileDefined ? [] : row.agentIds}
    {@const problems = new Map(
      row.allBlockers.flatMap((blocker) =>
        blocker.kind === 'cannot-load'
          ? [[blocker.workflowType, problemLocation(blocker.workflowType, brokenLine)] as const]
          : [],
      ),
    )}
    {@const workflowPath =
      schedule.workflowType === AGENT_RUN_TYPE
        ? internalWorkflowsPath()
        : workflowTypePath(schedule.workflowType)}

    {#if actions.notice !== null}
      <ScheduleNotice notice={actions.notice} onDismiss={actions.dismiss} />
    {/if}
    {#if overlay.failed}
      <FaultBanner treatment={OVERLAY_FAILURE} onRetry={overlay.refetch} />
    {/if}

    {#snippet heading()}
      <IdentifierText text={name} identifiers={scheduleNameIdentifiers(schedule, kind)} />
    {/snippet}
    {#snippet status()}
      {#if switchable}
        <span class="ib-schedule__switch" bind:this={switchHost}>
          <Toggle
            {...{ 'data-changes': true }}
            id="ib-schedule-on"
            label={copy.onSwitch}
            nameDetail={copy.onSwitchName(name)}
            checked={row.status === 'active'}
            disabled={writeGate.disabled || actions.busy}
            readonly={!switchWritable}
            {...workflowPaused
              ? {
                  description: copy.pausedWorkflowSwitch(row.workflowLabel),
                  descriptionVisible: false,
                }
              : {}}
            onValueChangeRequest={() => {
              if (schedule.status === 'paused') actions.resume.mutate(target);
              else actions.pause.mutate(target);
              // The switch follows the schedule once the page has read it again, not the click.
              return schedule.status === 'active';
            }}
          />
        </span>
        <Divider orientation="vertical" decorative class="ib-schedule__status-divider" />
      {/if}
      <StatusDot word={statusWord} data-status-word={statusWord} />
    {/snippet}
    {#snippet headerActions()}
      <div class="ib-schedule__actions">
        <div class="ib-schedule__action-row">
          {#if fileDefined && kind.kind === 'workflow-file'}
            <Button
              variant="secondary"
              size="sm"
              href={router.href(workflowEditPath(kind.file.id))}
            >
              <ExternalLink aria-hidden="true" size={14} />
              {copy.openFile}
            </Button>
          {:else if allowed.edit}
            <!-- Edit opens the form that writes, so while the server does not answer the shell holds it with the other controls that change the schedule. -->
            <Button
              data-changes
              variant="secondary"
              size="sm"
              disabled={writeGate.disabled}
              title={writeGate.title}
              onclick={() => router.navigate(scheduleEditPath(schedule.id))}
            >
              <Pencil aria-hidden="true" size={14} />
              {copy.edit}
            </Button>
          {:else if allowed.editInWorkflow}
            <Button
              variant="secondary"
              size="sm"
              href={router.href(workflowEditPath(schedule.workflowType))}
            >
              <Pencil aria-hidden="true" size={14} />
              {copy.edit}
            </Button>
          {/if}
          {#if allowed.runNow}
            <!-- A reason it is off keeps the button in the tab order, so the reason is read where it is felt. -->
            <Button
              data-changes
              variant="secondary"
              size="sm"
              disabled={runNowReason === null && !writable}
              title={writeGate.title}
              {...runNowReason === null
                ? {}
                : { 'aria-disabled': 'true', 'aria-describedby': 'ib-schedule-run-now-reason' }}
              onclick={() => {
                if (runNowReason === null) actions.runNow.mutate(target);
              }}
            >
              <Play aria-hidden="true" size={14} />
              {copy.runNow}
            </Button>
            {#if runNowReason !== null}
              <VisuallyHidden id="ib-schedule-run-now-reason">{runNowReason}</VisuallyHidden>
            {/if}
          {/if}
          {#if !fileDefined && kind.kind !== 'unknown'}
            <Dropdown id="ib-schedule-actions" placement="bottom-end">
              <Dropdown.Trigger caretVisible={false} data-changes>
                <Ellipsis aria-hidden="true" size={16} />
                <VisuallyHidden>{SCHEDULE_COPY.moreActions}</VisuallyHidden>
              </Dropdown.Trigger>
              <Dropdown.Menu>
                <Dropdown.Item
                  data-changes
                  variant="danger"
                  disabled={!allowed.cancel || !writable}
                  title={allowed.cancel ? undefined : copy.deleteInFile}
                  onclick={() => {
                    deleteTarget = target;
                    deleteDialogOpen = true;
                  }}
                >
                  <Trash2 aria-hidden="true" size={14} />
                  {copy.deleteAction}
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown>
          {/if}
        </div>
        {#if going !== undefined && allowed.runNow}
          <p
            class="ib-records__muted ib-schedule__action-note"
            data-testid="schedule-run-now-second"
          >
            {copy.runNowSecond}
          </p>
        {/if}
      </div>
    {/snippet}

    <PageHeader
      headingLevel={1}
      title={heading}
      titleText={name}
      {status}
      statusPlacement="inline"
      actions={headerActions}
    />

    <p class="ib-schedule__sentence" data-testid="schedule-status-line">
      {copy.sentence.runs}
      <Link underline="always" href={router.href(workflowPath)}
        >{#if row.blockers.some((blocker) => blocker.kind === 'cannot-load')}<code
            class="ib-identifier">{row.workflowType}</code
          >{:else}{row.workflowLabel}{/if}</Link
      >
      {#if agentNames.length > 0}
        {copy.sentence.with}
        {#each agentNames as agent, index (agent)}
          {#if index > 0}{index === agentNames.length - 1 ? ' and ' : ', '}{/if}<Link
            underline="always"
            href={router.href(agentPath(agent))}>{agentLabel(agent, rowQueries.agents)}</Link
          >
        {/each}
      {/if}
      <IdentifierText
        text={sentenceCadence(schedule, now)}
        identifiers={cadenceIdentifiers(schedule)}
      />.
    </p>
    {#if fileDefined && kind.kind === 'workflow-file'}
      <ScheduleFileChip id={kind.file.id} />
    {/if}
    {#if workflowPaused && file !== undefined}
      <p class="ib-schedule__sentence" data-testid="schedule-workflow-paused">
        {copy.workflowPaused.text(row.workflowLabel)}
        {#if file.hash !== null}
          {@const resumable = { id: file.id, hash: file.hash }}
          <Link
            underline="always"
            href="#resume-workflow"
            role="button"
            data-changes
            onclick={(event: MouseEvent) => {
              event.preventDefault();
              resumeWorkflow.mutate(resumable);
            }}>{copy.workflowPaused.resume}</Link
          >
        {/if}
      </p>
    {/if}
    {#if row.allBlockers.length > 0}
      <ScheduleBlockers blockers={row.allBlockers} {problems} id="ib-schedule-blockers" />
    {/if}
    <p class="ib-schedule__summary" data-testid="schedule-summary">
      {#if going !== undefined}
        <span class="ib-schedule__summary-part" data-tone="info" data-testid="schedule-running-now"
          >{copy.summary.runningNow}</span
        >{copy.summary.startedAgo(startedAgo(going.createdAt, now))}{', '}<Link
          underline="always"
          href={router.href(workflowDetailPath(going.id))}>{copy.openRun}</Link
        >{', '}
      {/if}
      {#each nextSummary(schedule, row, now, connection.unreachable || going !== undefined) as part, index (index)}
        {#if index > 0}{', '}{/if}
        {#if part.tone !== undefined}<span class="ib-schedule__summary-part" data-tone={part.tone}
            >{part.text}</span
          >{:else}{part.text}{/if}
      {/each}{', '}<ScheduleLastFire
        scheduleId={schedule.id}
        lastFireAt={schedule.lastFireAt}
        summary
      />
    </p>

    <div class="ib-schedule__layout">
      <section class="ib-schedule__main" aria-labelledby="ib-schedule-runs-heading">
        <div class="ib-schedule__section-head">
          <h2 id="ib-schedule-runs-heading" class="ib-records__subheading">{copy.runsHeading}</h2>
          <p class="ib-records__muted" data-testid="schedule-zone">
            {copy.runsNote(formatTimeZoneLabel(now, { style: 'long' }))}
          </p>
        </div>
        <ScheduleRuns
          {schedule}
          {row}
          {now}
          canSkip={allowed.skip && !writeGate.disabled}
          busy={actions.busy}
          onSkip={(occurrence) => actions.skip.mutate({ target, occurrence })}
          onUnskip={(occurrence) => actions.unskip.mutate({ target, occurrence })}
          runOnce={allowed.runNow
            ? {
                reason: runNowReason,
                disabled: !writable,
                onRun: () => actions.runNow.mutate(target),
              }
            : null}
        />
      </section>
      <ScheduleDetailsCard
        {schedule}
        {row}
        {input}
        agents={rowQueries.agents}
        editPath={allowed.edit ? scheduleEditPath(schedule.id) : undefined}
        {now}
      />
    </div>

    <ConfirmDialog
      bind:open={deleteDialogOpen}
      title={copy.deleteDialog.title(name)}
      description={copy.deleteDialog.description}
      confirmLabel={copy.deleteDialog.confirm}
      destructive
      onConfirm={() => {
        if (deleteTarget !== null) {
          actions.cancel.mutate(deleteTarget, { onSuccess: backToList });
        }
      }}
    />
  {/if}
</section>
