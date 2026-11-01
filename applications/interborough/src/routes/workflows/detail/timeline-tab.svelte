<script lang="ts">
  /**
   * The run's steps: a list of every durable step the engine recorded (`getTimeline()`), each with
   * a waterfall bar, and the open step beside it with what went in, what came out. The list is a ListDetail, so it moves with `j` and `k`,
   * keeps the open step in the address (`?step=`), and shows one pane at a time on a narrow screen.
   * The filter offers All, Failed and Waiting (steps that have begun and not ended); past
   * 500 steps the list pages and offers a jump to a step number. This component is orchestration:
   * the sibling modules under `./steps/`, `./timeline/` and `./async-activity/` draw and map.
   *
   * ## Linked selection
   *
   * Opening a step sets the shared selection (`./timeline/timeline-selection-store.svelte.ts`),
   * which the Events section reads to show only that step's events; clearing it there leaves the
   * step open here. The selection is the step's number, minted as `step-<n>`.
   *
   * ## What a step can do
   *
   * An activity waiting on an outside completion offers Complete, a stream offers its stored
   * chunks, and an activity that ran on a worker offers that worker's record. Each is a separate
   * component mounted in the open step, so a step that offers none shows none.
   *
   * ## Logs
   *
   * The lines the run logged are read once, under the same query as the Details rail's whole log,
   * and placed under the entry they belong to (`../runs/run-logs-data.ts`). The open step lists
   * its own lines, and the lines logged before the first step sit above the list. A run whose lines
   * cannot be placed shows none here; the rail still lists them whole.
   */
  import {
    Alert,
    Button,
    Collapsible,
    EmptyState,
    ErrorState,
    Input,
    ListDetail,
    SegmentedControl,
    Segment,
    Skeleton,
  } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import type {
    WeftClientActivity,
    HttpClient,
    WorkflowFinalizerStatus,
    WorkflowState,
    WorkflowTimelineEntry,
  } from '@lostgradient/weft';
  import { untrack } from 'svelte';

  import { RETRY_LABEL, RUN_STEPS_COPY, RUN_DETAIL_COPY } from '../../../app/copy.ts';
  import { routerSelectionLocationFor } from '../../../lib/router-selection-location.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import LogLines from '../runs/log-lines.svelte';
  import {
    LOGS_OPERATION,
    fetchRunLogs,
    placeLogLines,
    workflowLogsQueryKey,
    type LogsClient,
  } from '../runs/run-logs-data.ts';

  import { attachPendingActivitiesToSteps } from './async-activity/async-activity-matching.ts';
  import {
    pendingAsyncActivitiesQueryKey,
    pendingAsyncActivityObservations,
    PENDING_ASYNC_ACTIVITY_OPERATION,
  } from './async-activity/async-activity-query.ts';
  import AsyncActivityDrawer from './async-activity/async-activity-drawer.svelte';
  import ActivityWorkerProvenance from './async-activity/activity-worker-provenance.svelte';
  import RemoteTaskStep from './remote-task-step.svelte';
  import StepDetail from './steps/step-detail.svelte';
  import StepRow from './steps/step-row.svelte';
  import { openStepNumbers, stepWaterfall } from './steps/step-waterfall.ts';
  import StreamChunksView from './streams/stream-chunks-view.svelte';
  import type { StreamChunksClient } from './streams/stream-chunks-data.ts';
  import FinalizerStrip from './timeline/finalizer-strip.svelte';
  import {
    TIMELINE_QUICK_FILTERS,
    filterTimelineEntries,
    needsTimelinePagination,
    timelineEntriesForPage,
    timelinePageCount,
    timelinePageForStep,
    timelineQuickFilterLabel,
    type TimelineQuickFilter,
  } from './timeline/timeline-filters.ts';
  import { stepNumberFromRunStepId, timelineStepId } from './timeline/timeline-mapping.ts';
  import {
    setTimelineSelection,
    timelineSelectionFor,
  } from './timeline/timeline-selection-store.svelte.ts';
  import type { WorkflowLiveObservations } from './timeline/workflow-live-observations.svelte.ts';
  import { workflowTimelineQueryKey } from './workflow-timeline-data.ts';

  interface TimelineTabProps {
    readonly client: Pick<HttpClient, 'getTimeline'> & {
      readonly operations: Pick<HttpClient['operations'], typeof PENDING_ASYNC_ACTIVITY_OPERATION> &
        Partial<Pick<HttpClient['operations'], 'weft.tasks.get'>> &
        Partial<StreamChunksClient['operations']> &
        LogsClient['operations'];
      readonly activity: Pick<WeftClientActivity, 'complete' | 'completeExceptionally'>;
    };
    readonly workflow: WorkflowState;
    readonly liveObservations: WorkflowLiveObservations;
    /** `weft.workflows.finalizer.get` result, fetched once by `runs/run-engine.svelte.ts` and shared with the header badge — see `finalizer-strip.svelte`'s module doc. */
    readonly finalizerStatus: WorkflowFinalizerStatus | null | undefined;
    /** Whether the principal holds `streams:read`, which a stream's chunks need. Without it no stream link renders. */
    readonly canReadStreams?: boolean | undefined;
    /** The present moment, for the bar of a step still going; the run page passes its ticking clock. */
    readonly now?: number | undefined;
  }

  let {
    client,
    workflow,
    liveObservations,
    finalizerStatus,
    canReadStreams = false,
    now,
  }: TimelineTabProps = $props();

  const timelineQuery = createQuery(() => ({
    queryKey: workflowTimelineQueryKey(workflow.id),
    queryFn: () => client.getTimeline(workflow.id),
  }));

  const queryClient = useQueryClient();
  const pendingAsyncActivitiesQuery = createQuery(() => ({
    queryKey: pendingAsyncActivitiesQueryKey(workflow.id),
    queryFn: () =>
      client.operations[PENDING_ASYNC_ACTIVITY_OPERATION]({
        workflowId: workflow.id,
        limit: 200,
      }),
  }));

  const entries = $derived(timelineQuery.data ?? []);

  // The same query as the Details rail's Logs section, so the two share one read.
  const logsQuery = createQuery(() => ({
    queryKey: workflowLogsQueryKey(workflow.id),
    queryFn: () => fetchRunLogs(client, workflow.id),
    enabled: client.operations[LOGS_OPERATION] !== undefined,
  }));
  const placement = $derived(placeLogLines(entries, logsQuery.data?.lines ?? []));
  const linesBeforeFirstStep = $derived(placement.kind === 'by-step' ? placement.beforeFirst : []);
  let beforeFirstOpen = $state(false);

  /** The lines placed under one entry, by its checkpoint key. */
  function linesUnder(step: number) {
    return placement.kind === 'by-step' ? placement.byStep.get(step) : undefined;
  }

  // One scale for every step of the run, whatever page or filter is showing.
  const openSteps = $derived(openStepNumbers(entries, workflow.status));
  const bars = $derived(
    stepWaterfall(entries, {
      runStartedAt: workflow.createdAt,
      now: now ?? Date.now(),
      runStatus: workflow.status,
    }),
  );

  let quickFilter = $state<TimelineQuickFilter>('all');
  const filteredEntries = $derived(filterTimelineEntries(entries, quickFilter, openSteps));

  let pageIndex = $state(0);

  function changeQuickFilter(next: TimelineQuickFilter): void {
    quickFilter = next;
    pageIndex = 0;
  }
  const paginated = $derived(needsTimelinePagination(filteredEntries.length));
  const pageCount = $derived(timelinePageCount(filteredEntries.length));
  const pageEntries = $derived(
    paginated ? timelineEntriesForPage(filteredEntries, pageIndex) : filteredEntries,
  );

  // Called once at component init, not reactively: `timelineSelectionFor`
  // both reads AND (conditionally) mutates the shared module-level store,
  // which Svelte forbids inside a `$derived` evaluation. `workflow.id` is
  // stable for this component's whole lifetime regardless (the route
  // outlet's `{#key router.pathname}` guarantees a fresh mount per workflow
  // id change — see `timeline-selection-store.svelte.ts`'s module doc).
  // `untrack()` makes that one-time read explicit instead of triggering the
  // `state_referenced_locally` compiler warning.
  timelineSelectionFor(untrack(() => workflow.id));

  /** Below this width the list and the open step take turns, so each keeps room to read. */
  const STEPS_PUSH_BELOW = 600;
  const STEPS_LIST_WIDTH = 240;

  // The run page has two addresses, and the outlet mounts this fresh for each, so the address it
  // was opened at is the one its selection belongs to.
  const selectionLocation = routerSelectionLocationFor(untrack(() => router.pathname));
  let selectedKey = $state<string | null>(null);
  const openEntry = $derived(
    selectedKey === null ? undefined : entries.find((entry) => String(entry.step) === selectedKey),
  );

  /** Links the open step to the Events section, which shows only that step's events. */
  function changeSelection(key: string | null): void {
    const step = key === null ? null : Number(key);
    setTimelineSelection(step !== null && Number.isSafeInteger(step) ? timelineStepId(step) : null);
  }

  let jumpToStepText = $state('');

  function jumpToStep(): void {
    const step = Number(jumpToStepText.trim());
    if (!Number.isSafeInteger(step)) return;
    const target = timelinePageForStep(filteredEntries, step);
    if (target !== null) pageIndex = target;
  }

  // A step opened from the address (`?step=450`) can be on a later page than the first, and the list
  // finds an open step only among the rows it shows. So when the selection changes to a step on
  // another page, the page follows it once. The page is left alone after that, so paging away from
  // the open step does not snap back.
  let pageFollowedKey: string | null = null;
  $effect(() => {
    const key = selectedKey;
    const candidates = filteredEntries;
    if (key === null) {
      pageFollowedKey = null;
      return;
    }
    if (key === pageFollowedKey) return;
    const target = timelinePageForStep(candidates, Number(key));
    if (target === null) return;
    pageFollowedKey = key;
    if (untrack(() => pageIndex) !== target) pageIndex = target;
  });

  const attachedPendingActivities = $derived(
    attachPendingActivitiesToSteps(
      pendingAsyncActivityObservations(pendingAsyncActivitiesQuery.data?.items ?? []),
      entries,
    ),
  );
  const unattachedPendingActivities = $derived(
    attachedPendingActivities.filter((activity) => activity.stepId === null),
  );

  // A stream step links to a view of its stored chunks (COR-1462), for a principal who can read them.
  const streamChunksOperation = $derived(client.operations['weft.workflows.streams.chunks']);
  const streamsClient = $derived.by((): StreamChunksClient | undefined =>
    canReadStreams && streamChunksOperation !== undefined
      ? { operations: { 'weft.workflows.streams.chunks': streamChunksOperation } }
      : undefined,
  );
  let openStreamKey = $state<string | null>(null);

  /** The stream operation behind a top-level mapped step, whose label is the stream's key. */
  function streamEntryFor(stepId: string): WorkflowTimelineEntry | undefined {
    const stepNumber = stepNumberFromRunStepId(stepId);
    if (stepNumber === null || stepId !== timelineStepId(stepNumber)) return undefined;
    return entries.find(
      (candidate) => candidate.step === stepNumber && candidate.operationType === 'stream',
    );
  }

  /** The timeline step whose settled-activity provenance is open. */
  let provenanceStep = $state<number | null>(null);
  const readTask = $derived(client.operations['weft.tasks.get']);

  /**
   * The settled activity entry behind a mapped step that names the ledger record it ran as. The
   * identity is Weft's own (`WorkflowTimelineEntry.taskOperationId`), never rebuilt from the step.
   */
  function settledActivityEntry(stepId: string): WorkflowTimelineEntry | undefined {
    const stepNumber = stepNumberFromRunStepId(stepId);
    if (stepNumber === null || stepId !== timelineStepId(stepNumber)) return undefined;
    return entries.find(
      (candidate) =>
        candidate.step === stepNumber &&
        candidate.operationType === 'activity' &&
        candidate.status !== 'running' &&
        candidate.taskOperationId !== undefined,
    );
  }

  /**
   * The ledger key behind a mapped activity step, when the step may be remote. A step whose entry
   * names its record (`taskOperationId`) is remote, and the key is that id. A running step names
   * none, so a step with a live pending-activity observation is keyed by that observation's
   * `token`, the ledger key B13's in-flight drawer reads, and is `probe`d: it is offered only if
   * the ledger holds a record for the token. Never the pending record's own `operationId`.
   */
  function remoteTaskFor(
    stepId: string,
  ): { label: string; operationId: string; probe: boolean } | undefined {
    const stepNumber = stepNumberFromRunStepId(stepId);
    if (stepNumber === null || stepId !== timelineStepId(stepNumber)) return undefined;
    const found = entries.find(
      (candidate) => candidate.step === stepNumber && candidate.operationType === 'activity',
    );
    if (found === undefined) return undefined;
    if (found.taskOperationId !== undefined) {
      return { label: found.operationLabel, operationId: found.taskOperationId, probe: false };
    }
    if (found.status !== 'running') return undefined;
    const pending = attachedPendingActivities.find((candidate) => candidate.stepId === stepId);
    return pending === undefined
      ? undefined
      : { label: found.operationLabel, operationId: pending.token, probe: true };
  }

  let openDrawerToken = $state<string | null>(null);
  const openActivity = $derived(
    attachedPendingActivities.find((activity) => activity.token === openDrawerToken) ?? null,
  );

  function closeDrawer(): void {
    openDrawerToken = null;
  }

  function handleResolved(token: string): void {
    liveObservations.forgetToken(token);
    void queryClient.invalidateQueries({
      queryKey: pendingAsyncActivitiesQueryKey(workflow.id),
    });
    openDrawerToken = null;
  }
</script>

<div class="weft-timeline-tab">
  <FinalizerStrip baseStatus={workflow.status} status={finalizerStatus} />

  {#each unattachedPendingActivities as activity (activity.token)}
    <Alert variant="warning">
      <span class="weft-timeline-tab__unattached-name">{activity.activityName}</span>
      {RUN_STEPS_COPY.awaitingCompletion}. {RUN_STEPS_COPY.unattachedNote}
      <Button
        variant="secondary"
        size="sm"
        label={RUN_STEPS_COPY.complete}
        onclick={() => (openDrawerToken = activity.token)}
      />
    </Alert>
  {/each}

  {#if timelineQuery.isPending}
    <Skeleton height="8rem" />
  {:else if timelineQuery.isError}
    <ErrorState
      variant="flat"
      title={RUN_STEPS_COPY.loadFailedTitle}
      description={timelineQuery.error.message}
      headingLevel={3}
      retryLabel={RETRY_LABEL}
      onRetry={() => void timelineQuery.refetch()}
    />
  {:else if entries.length === 0}
    <EmptyState
      kind="first-use"
      headingLevel={3}
      title={RUN_STEPS_COPY.emptyTitle}
      description={RUN_STEPS_COPY.emptyDescription}
    />
  {:else}
    {#if linesBeforeFirstStep.length > 0}
      <section data-section="logs-before-first-step">
        <Collapsible
          bind:open={beforeFirstOpen}
          trigger={RUN_STEPS_COPY.logsBeforeFirst(linesBeforeFirstStep.length)}
        >
          <LogLines lines={linesBeforeFirstStep} label={RUN_STEPS_COPY.logsBeforeFirstListLabel} />
        </Collapsible>
      </section>
    {/if}
    <div class="ib-steps-frame" data-testid="run-steps">
      <ListDetail
        items={pageEntries}
        key={(entry: WorkflowTimelineEntry) => String(entry.step)}
        label={RUN_STEPS_COPY.listLabel}
        detailLabel={RUN_STEPS_COPY.detailLabel}
        emptyTitle={RUN_STEPS_COPY.chooseTitle}
        emptyDescription={RUN_STEPS_COPY.chooseDescription}
        selectionParameter="step"
        {selectionLocation}
        bind:selectedKey
        onSelectedKeyChange={changeSelection}
        storageKey="interborough-run-steps"
        pushBelow={STEPS_PUSH_BELOW}
        defaultListWidth={STEPS_LIST_WIDTH}
      >
        {#snippet header()}
          <div class="ib-steps-summary">
            <h3 class="ib-steps-summary__title">{RUN_STEPS_COPY.heading}</h3>
            <span class="ib-steps-summary__count" data-testid="steps-count">
              {RUN_STEPS_COPY.count(filteredEntries.length, entries.length)}
            </span>
          </div>
          <SegmentedControl
            id={`timeline-quick-filter-${workflow.id}`}
            label={RUN_STEPS_COPY.filterLabel}
            labelVisible={false}
            density="toolbar"
            value={quickFilter}
            onValueChange={changeQuickFilter}
          >
            {#each TIMELINE_QUICK_FILTERS as filter (filter)}
              <Segment value={filter}>{timelineQuickFilterLabel(filter)}</Segment>
            {/each}
          </SegmentedControl>
          {#if paginated}
            <nav class="ib-steps-pagination" aria-label={RUN_STEPS_COPY.paginationLabel}>
              <Button
                variant="ghost"
                size="sm"
                label={RUN_STEPS_COPY.previous}
                disabled={pageIndex === 0}
                onclick={() => (pageIndex = Math.max(0, pageIndex - 1))}
              />
              <span class="ib-steps-pagination__label"
                >{RUN_STEPS_COPY.page(pageIndex + 1, pageCount)}</span
              >
              <Button
                variant="ghost"
                size="sm"
                label={RUN_STEPS_COPY.next}
                disabled={pageIndex >= pageCount - 1}
                onclick={() => (pageIndex = Math.min(pageCount - 1, pageIndex + 1))}
              />
              <Input
                id={`timeline-jump-to-step-${workflow.id}`}
                label={RUN_STEPS_COPY.jumpToStep}
                labelVisible={false}
                placeholder={RUN_STEPS_COPY.jumpToStep}
                inputmode="numeric"
                bind:value={jumpToStepText}
                onkeydown={(event) => {
                  if (event.key === 'Enter') jumpToStep();
                }}
              />
              <Button variant="ghost" size="sm" label={RUN_STEPS_COPY.go} onclick={jumpToStep} />
            </nav>
          {/if}
        {/snippet}
        {#snippet list(entry, row)}
          <StepRow {entry} bar={bars.get(entry.step)} open={openSteps.has(entry.step)} {row} />
        {/snippet}
        {#snippet listEmpty()}
          <EmptyState
            kind="filtered"
            size="compact"
            headingLevel={4}
            title={RUN_STEPS_COPY.filteredTitle}
            description={RUN_STEPS_COPY.filteredDescription}
            onClearFilters={() => changeQuickFilter('all')}
            clearFiltersLabel={RUN_STEPS_COPY.showAll}
          />
        {/snippet}
        {#snippet empty()}
          <EmptyState
            kind="first-use"
            headingLevel={4}
            title={RUN_STEPS_COPY.chooseTitle}
            description={RUN_STEPS_COPY.chooseDescription}
          />
        {/snippet}
        {#snippet detail(entry)}
          <StepDetail
            {entry}
            bar={bars.get(entry.step)}
            open={openSteps.has(entry.step)}
            logs={linesUnder(entry.step)}
            actions={stepActions}
          />
        {/snippet}
      </ListDetail>
    </div>
  {/if}

  {#if streamsClient !== undefined && openStreamKey !== null}
    {#key openStreamKey}
      <StreamChunksView
        client={streamsClient}
        workflowId={workflow.id}
        streamKey={openStreamKey}
        status={workflow.status}
        onClose={() => (openStreamKey = null)}
      />
    {/key}
  {/if}
</div>

{#snippet stepActions()}
  <!-- Reads the open step, so a step that offers nothing renders nothing. -->
  {#if openEntry !== undefined}
    {@const stepId = timelineStepId(openEntry.step)}
    {@const activity = attachedPendingActivities.find((candidate) => candidate.stepId === stepId)}
    {#if activity}
      <div class="weft-timeline-tab__step-async">
        <span>{RUN_STEPS_COPY.awaitingCompletion}</span>
        <Button
          variant="secondary"
          size="sm"
          label={RUN_STEPS_COPY.complete}
          onclick={() => (openDrawerToken = activity.token)}
        />
      </div>
    {/if}
    {@const stream = streamsClient === undefined ? undefined : streamEntryFor(stepId)}
    {#if stream !== undefined}
      <div class="weft-timeline-tab__step-stream">
        <Button
          variant="ghost"
          size="sm"
          label={RUN_DETAIL_COPY.streams.viewChunks(stream.operationLabel)}
          aria-expanded={openStreamKey === stream.operationLabel}
          onclick={() => (openStreamKey = stream.operationLabel)}
        />
      </div>
    {/if}
    {@const remote = readTask === undefined ? undefined : remoteTaskFor(stepId)}
    {#if remote !== undefined && readTask !== undefined}
      {#key remote.operationId}
        <RemoteTaskStep
          operationId={remote.operationId}
          label={remote.label}
          {readTask}
          probe={remote.probe}
        />
      {/key}
    {/if}
    {@const settled = readTask === undefined ? undefined : settledActivityEntry(stepId)}
    {#if settled?.taskOperationId !== undefined && readTask !== undefined}
      <div class="weft-timeline-tab__step-provenance">
        <Button
          variant="ghost"
          size="sm"
          label={RUN_STEPS_COPY.workerProvenanceFor(settled.operationLabel)}
          aria-expanded={provenanceStep === settled.step}
          onclick={() => (provenanceStep = provenanceStep === settled.step ? null : settled.step)}
        />
        {#if provenanceStep === settled.step}
          <ActivityWorkerProvenance operationId={settled.taskOperationId} {readTask} />
        {/if}
      </div>
    {/if}
  {/if}
{/snippet}

{#if openActivity}
  <AsyncActivityDrawer
    {client}
    open={true}
    activity={openActivity}
    onClose={closeDrawer}
    onResolved={handleResolved}
  />
{/if}

<style>
  .weft-timeline-tab {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .weft-timeline-tab__unattached-name {
    font-weight: 600;
  }

  /* The list owns its height and scrolls each pane, so the frame gives it one. */
  .ib-steps-frame {
    block-size: max(24rem, 60dvh);
    min-inline-size: 0;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
  }

  .ib-steps-summary {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--cinder-space-2);
  }

  .ib-steps-summary__title {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: 600;
  }

  .ib-steps-summary__count {
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }

  .ib-steps-pagination {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  .ib-steps-pagination__label {
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
    white-space: nowrap;
  }

  .weft-timeline-tab__step-provenance {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
  }

  .weft-timeline-tab__step-async {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2);
    font-size: var(--cinder-text-sm);
  }
</style>
