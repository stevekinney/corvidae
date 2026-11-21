<script lang="ts">
  /**
   * `/runs`: what the agents have done, newest first, in the words of a task (`run-rows.ts`). The
   * header says what the page is, with Start run as its secondary "+". Under it, one filter bar that
   * never wraps: the status segments, each with its count (All, Waiting on you, Running, Done,
   * Failed, Canceled), the Started by and Agent chips, and Search runs. The filters are the
   * address's, so a filtered list can be shared. Then one list: status-first two-line rows
   * (`run-list-row.svelte`) under day bands that name the zone their times are in, ten at a time
   * with "Showing 10 of 20" and Load more, and the runs a schedule missed as one collapsed row last
   * among the runs of the day the misses were logged (`missed-runs-row.svelte`).
   *
   * The Bureau's task listing has no total, so every page is read (`listAllTasks`, the read Home's
   * Running now count makes too) and the segments, the facets, the search and the page of ten are
   * all applied here. A list the filters leave empty says so and offers Clear filters. The engine's
   * own table of workflows is the Health area's; it is not here.
   *
   * The page keeps its header in every state, so it draws its own (`ownsStatesOnPatterns` in
   * `app/views.ts`): nothing yet is an empty state that is the page, with no filter bar and a
   * primary Start run beside a secondary Chat with an agent; filters that match nothing keep the
   * bar, every count at 0, over a Clear filters state that names the agent; a read in progress
   * shows placeholders after 300 ms (`run-list-states.svelte`), and once it is slow, a Cancel that
   * leaves "Loading canceled" and Try again; a read that failed with nothing to show is the full
   * error state with the header's "+" muted. A server that does not answer is the shell's banner,
   * with the list on screen at full contrast and the header's "+" held by the stale region.
   */
  import {
    Button,
    DataList,
    EmptyState,
    ErrorState,
    FilterBar,
    LoadMore,
    PageHeader,
    StaleRegion,
    type AppliedFilter,
    type FacetDefinition,
    type FilterSegment,
  } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { getConnection } from '../../../app/connection.svelte.ts';
  import ListPageEmpty from '../../../app/list-page-empty.svelte';
  import { CONNECTION_COPY, RETRY_LABEL } from '../../../app/copy/views.ts';
  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import { useBureauEventsLive } from '../../../app/live-polling.svelte.ts';
  import { agentLabel as agentLabelOf } from '../../../lib/agent-label.ts';
  import { readScheduleAttention } from '../../../lib/bureau-attention.ts';
  import { listAgents, listAllContexts } from '../../../lib/bureau-client.ts';
  import { listAllGoals } from '../../../lib/bureau-goals.ts';
  import { listAllTasks } from '../../../lib/bureau-tasks.ts';
  import { followLinks } from '../../../lib/follow-links.ts';
  import { viewerTimeZone } from '../../../lib/format/clock.ts';
  import { usePluginTitle } from '../../../lib/plugin-title.svelte.ts';
  import { workflowTypeName } from '../../../lib/workflow-type-name.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { getPrincipalStore } from '../../../lib/scopes.svelte.ts';
  import { HOME_CLOCK_MILLISECONDS } from '../../home/home-clock.svelte.ts';
  import { REVIEW_POLL_MILLISECONDS } from '../../reviews/reviews-data.ts';
  import { loadModelAgents } from '../../schedules/schedule-row-context.ts';
  import MissedRunsRow from './missed-runs-row.svelte';
  import { readRunSchedules } from './missed-runs.ts';
  import RunListRow from './run-list-row.svelte';
  import RunListStates, { RUN_LIST_LOADING_DELAY_MILLISECONDS } from './run-list-states.svelte';
  import { runListFailure, runNoMatchDescription } from './run-list-states.ts';
  import {
    buildRunRows,
    filterLabelOf,
    filterRunRows,
    isEngineRunTask,
    isRunRowRunning,
    parseRunFilter,
    RUN_PAGE_SIZE,
    runDayGroup,
    runListEntries,
    runListRows,
    runSegmentCounts,
    runStatusWord,
    serializeRunFilter,
    visibleRunSegments,
    type RunFilter,
    type RunListEntry,
  } from './run-rows.ts';
  import { STARTED_BY_FILTER_LABELS, STARTED_BY_KINDS } from './started-by.ts';

  /** The form that starts a run. */
  const START_RUN_PATH = '/runs/new';
  /** The query that reads every task: its key is cancelled by name when a slow read is given up. */
  const TASKS_QUERY_KEY = ['bureau-tasks', 'runs', 'all'] as const;
  /** How often a running run's duration is read again while one is on the list. */
  const RUNNING_CLOCK_MILLISECONDS = 1_000;
  const filter = $derived(parseRunFilter(router.current.search));
  const queryClient = useQueryClient();
  const connection = getConnection();
  // A run only the workflow engine holds opens on the engine's page, for a caller who may read it.
  const engineReadable = $derived(getPrincipalStore().hasScope('workflows:read'));

  // The queries below follow `bureau.events`: a run by `run.*` and `action`, a goal by `goal.*`,
  // a chat by `session.*` (`app/bureau-event-queries.ts`). Each asks again on a timer only while the
  // feed is not live, read in the option getter so the timer returns when the feed is lost.
  const bureauLive = useBureauEventsLive();
  /** Whether the list still holds an engine-only instance waiting for an execution slot. */
  function hasQueuedWorkflowInstance(tasks: Parameters<typeof buildRunRows>[0]['tasks']): boolean {
    return tasks.some(
      (task) =>
        task.status === 'submitted' &&
        task.workflow?.type !== 'scheduleTick' &&
        isEngineRunTask(task),
    );
  }
  // Every run, every page of them: the listing has no total, and the segments count all of them.
  const tasks = createQuery(() => {
    const polling = !bureauLive();
    return {
      queryKey: TASKS_QUERY_KEY,
      queryFn: ({ signal }: { signal: AbortSignal }) => listAllTasks({}, { signal }),
      // A catalog run is announced by `run.settled` alone: no event says it took an execution slot.
      // Keep this one query current while an engine-only instance is queued, even with a live feed;
      // its next read stops the timer once the instance starts or settles (COR-1730, COR-2433).
      // poll-reason: fallback
      refetchInterval: (query) =>
        polling || hasQueuedWorkflowInstance(query.state.data ?? [])
          ? REVIEW_POLL_MILLISECONDS
          : false,
      retry: false,
    };
  }, undefined);
  // Every goal, a page at a time: a run past the first hundred is still a run.
  const goals = createQuery(() => {
    const polling = !bureauLive();
    return {
      queryKey: queryKeys.goals.runs(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listAllGoals({ signal }),
      // poll-reason: fallback
      refetchInterval: polling ? REVIEW_POLL_MILLISECONDS : false,
      retry: false,
    };
  }, undefined);
  // The agents to filter by come from the catalog as well as the runs, so an agent with no run yet
  // can be chosen, and each is named as a person reads it.
  const agents = createQuery(
    () => ({
      queryKey: ['agents', 'runs'] as const,
      queryFn: () => listAgents(),
      retry: false,
    }),
    undefined,
  );
  const chats = createQuery(() => {
    const polling = !bureauLive();
    return {
      queryKey: queryKeys.contexts.runs(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listAllContexts({ signal }),
      // poll-reason: fallback
      refetchInterval: polling ? REVIEW_POLL_MILLISECONDS : false,
      retry: false,
    };
  }, undefined);
  // The schedules' names, which title the runs their fires started, and the runs each missed. A
  // caller who may not read schedules, or a read that fails, loses only those: never the list.
  const schedules = createQuery(
    () => ({
      queryKey: ['bureau-schedules', 'runs'] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => readRunSchedules({ signal }),
      retry: false,
    }),
    undefined,
  );

  function agentLabel(agentName: string): string {
    return agentLabelOf(agentName, agents.data);
  }

  // A run a trigger started names its plugin by its title.
  const pluginTitle = usePluginTitle();
  // A schedule's chat run says when its schedule runs (row 53l).
  function scheduleCadence(scheduleId: string): string | undefined {
    return schedules.data?.cadences?.get(scheduleId);
  }

  const everyRun = $derived(
    runListRows(
      buildRunRows({
        tasks: tasks.data ?? [],
        goals: goals.data ?? [],
        chats: chats.data ?? [],
        scheduleNames: schedules.data?.names ?? new Map<string, string>(),
      }),
    ),
  );
  // Every filter but the status: the segments count what these leave, so each says what choosing it
  // would show, and a filter that matches nothing makes every count 0.
  const others = $derived<RunFilter>({
    ...(filter.agent === undefined ? {} : { agent: filter.agent }),
    ...(filter.startedBy === undefined ? {} : { startedBy: filter.startedBy }),
    ...(filter.workflow === undefined ? {} : { workflow: filter.workflow }),
    ...(filter.search === undefined ? {} : { search: filter.search }),
  });
  const unsegmented = $derived(filterRunRows(everyRun, others, agentLabel));
  const counts = $derived(runSegmentCounts(unsegmented));
  const rows = $derived(
    filter.status === undefined
      ? unsegmented
      : filterRunRows(unsegmented, { status: filter.status }, agentLabel),
  );
  const filtered = $derived(Object.keys(filter).length > 0);

  // Ten runs at a time. Load more shows ten more; a change of filter starts at ten again.
  const filterKey = $derived(serializeRunFilter(filter));
  let paging = $state({ filterKey: '', shown: RUN_PAGE_SIZE });
  const shown = $derived(paging.filterKey === filterKey ? paging.shown : RUN_PAGE_SIZE);
  function showMore(): void {
    paging = { filterKey, shown: shown + RUN_PAGE_SIZE };
  }
  // The missed runs are a schedule's, not a filter's: a filtered list leaves them out.
  const entries = $derived(
    runListEntries(rows, filtered ? [] : (schedules.data?.missed ?? []), shown),
  );
  const shownRuns = $derived(Math.min(shown, rows.length));

  // The clock the rows' waits and running durations are counted to: each second while a run on the
  // list is going, so its duration ticks in place, and each minute otherwise.
  const zone = viewerTimeZone();
  let now = $state(Date.now());
  const going = $derived(rows.some((row) => isRunRowRunning(row, now)));
  $effect(() => {
    const period = going ? RUNNING_CLOCK_MILLISECONDS : HOME_CLOCK_MILLISECONDS;
    // poll-reason: clock
    const timer = setInterval(() => {
      now = Date.now();
    }, period);
    return () => clearInterval(timer);
  });

  // The agents of the schedules' runs that are due, which are the only rows that say whether a
  // provider is connected for them (row 10h): only a list that has one asks, as the Schedules
  // list does, whether no provider is connected and which of those agents needs a model.
  const dueScheduleAgents = $derived(
    [
      ...new Set(
        everyRun
          .filter(
            (row) =>
              row.origin.kind === 'schedule' &&
              row.agentName !== null &&
              runStatusWord(row, now) === 'Scheduled',
          )
          .map((row) => row.agentName ?? ''),
      ),
    ].toSorted(),
  );
  const providerHold = createQuery(
    () => ({
      queryKey: ['runs', 'provider-hold', dueScheduleAgents.join(',')] as const,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const [attention, modelAgents] = await Promise.all([
          readScheduleAttention({ signal }),
          loadModelAgents(dueScheduleAgents, { signal }),
        ]);
        return { noProvider: attention.noProvider, modelAgents };
      },
      enabled: dueScheduleAgents.length > 0,
      retry: false,
    }),
    undefined,
  );
  // What holds a schedule from starting its due run (row 10h): the workflow whose file cannot
  // load, and no provider for an agent whose definition names a model.
  function scheduleHolds(scheduleId: string, agentName: string | null): readonly string[] {
    const blocked = schedules.data?.blockers?.get(scheduleId);
    const provider = providerHold.data;
    const needsModel = agentName !== null && provider?.modelAgents.has(agentName) === true;
    return [
      ...(blocked === undefined ? [] : [blocked]),
      ...(provider?.noProvider === true && needsModel ? [TASK_COPY.list.holds.noProvider] : []),
    ];
  }

  const agentNames = $derived(
    [
      ...new Set([
        ...(agents.data ?? []).map((agent) => agent.name),
        ...everyRun.flatMap((row) => (row.agentName === null ? [] : [row.agentName])),
        ...(filter.agent === undefined ? [] : [filter.agent]),
      ]),
    ].toSorted(),
  );

  // The workflows to filter by are the ones the runs ran on (row 52d), each named as a person
  // reads it, so "Chat with an agent" and "Release notes" are choices and `agentRun` is not.
  const workflowTypes = $derived(
    [
      ...new Set([
        ...everyRun.flatMap((row) => (row.workflowType == null ? [] : [row.workflowType])),
        ...(filter.workflow === undefined ? [] : [filter.workflow]),
      ]),
    ].toSorted((left, right) => workflowTypeName(left).localeCompare(workflowTypeName(right))),
  );

  const segments = $derived<FilterSegment[]>(
    visibleRunSegments(counts, filter.status).map((value) => ({
      value,
      label: TASK_COPY.list.segments[value],
      // The counts wait for every read: a segment is not 0 because a read has not arrived.
      count: loading ? 'pending' : counts[value],
    })),
  );
  const facets = $derived<FacetDefinition[]>([
    {
      type: 'choice',
      key: 'startedBy',
      label: TASK_COPY.startedByLabel,
      multiple: false,
      options: STARTED_BY_KINDS.map((value) => ({
        value,
        label: STARTED_BY_FILTER_LABELS[value],
      })),
    },
    {
      type: 'choice',
      key: 'workflow',
      label: TASK_COPY.workflowLabel,
      multiple: false,
      options: workflowTypes.map((value) => ({ value, label: workflowTypeName(value) })),
    },
    {
      type: 'choice',
      key: 'agent',
      label: TASK_COPY.agentLabel,
      multiple: false,
      options: agentNames.map((name) => ({ value: name, label: filterLabelOf(agentLabel(name)) })),
    },
  ]);
  // The chips that move into the Filter menu when the row cannot hold them, least used first: a
  // chip with a filter applied never moves, so an applied filter stays visible and removable
  // (row 52x).
  const FOLD_ORDER = ['workflow', 'agent', 'startedBy'] as const;
  const appliedFilters = $derived<AppliedFilter[]>([
    ...(filter.startedBy === undefined
      ? []
      : [{ key: 'startedBy', value: filter.startedBy, label: TASK_COPY.startedByLabel }]),
    ...(filter.workflow === undefined
      ? []
      : [{ key: 'workflow', value: filter.workflow, label: TASK_COPY.workflowLabel }]),
    ...(filter.agent === undefined
      ? []
      : [{ key: 'agent', value: filter.agent, label: TASK_COPY.agentLabel }]),
  ]);

  // What is typed in Search runs. The address holds it as typed, and the list reads it trimmed, so
  // a space at the end of a word is not taken back while it is typed.
  let typed = $state(untrack(() => filter.search ?? ''));

  function clearFilters(): void {
    typed = '';
    router.navigate('/runs', { replace: true });
  }

  function change(next: Record<string, string>): void {
    const params = new URLSearchParams(serializeRunFilter(filter));
    for (const [key, value] of Object.entries(next)) {
      if (value === '') params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    router.navigate(`/runs${query === '' ? '' : `?${query}`}`, { replace: true });
  }

  function search(query: string): void {
    typed = query;
    change({ q: query });
  }

  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  // A list built from what could be read would pass a missing goal or chat off as none: the runs
  // of a goal would be gone and the runs of a chat would lose their origin. Any of the three
  // failing with nothing cached is a failed list, and Try again reads the ones with nothing yet.
  const failed = $derived(
    (tasks.isError && tasks.data === undefined) ||
      (goals.isError && goals.data === undefined) ||
      (chats.isError && chats.data === undefined),
  );
  const failure = $derived(
    runListFailure([
      { operation: 'bureau.tasks.list', error: tasks.data === undefined ? tasks.error : null },
      { operation: 'bureau.goals.list', error: goals.data === undefined ? goals.error : null },
      { operation: 'bureau.contexts.list', error: chats.data === undefined ? chats.error : null },
    ]),
  );
  const loading = $derived(tasks.isPending || goals.isPending || chats.isPending);

  // Cancel, in the status line a slow read shows, gives the read up: the rows are replaced by
  // "Loading canceled" and Try again, and the header and the bar stay. Reads that go on to deliver
  // (the fallback timer asks again) end it, because it is the state of a list with nothing yet.
  let canceled = $state(false);
  const showCanceled = $derived(canceled && loading);
  let filterBarRevealed = $state(false);
  $effect(() => {
    filterBarRevealed = false;
    if (!loading) return;
    // poll-reason: timer
    const timer = setTimeout(() => {
      filterBarRevealed = true;
    }, RUN_LIST_LOADING_DELAY_MILLISECONDS);
    return () => clearTimeout(timer);
  });
  function cancelLoading(): void {
    canceled = true;
    void queryClient.cancelQueries({ queryKey: TASKS_QUERY_KEY });
    void queryClient.cancelQueries({ queryKey: queryKeys.goals.runs() });
    void queryClient.cancelQueries({ queryKey: queryKeys.contexts.runs() });
  }
  function retry(): void {
    canceled = false;
    if (tasks.data === undefined) void tasks.refetch();
    if (goals.data === undefined) void goals.refetch();
    if (chats.data === undefined) void chats.refetch();
  }
  const firstUse = $derived(!loading && !failed && everyRun.length === 0);
  const noMatch = $derived(
    runNoMatchDescription(
      filter,
      filter.agent === undefined ? undefined : agentLabel(filter.agent),
    ),
  );
</script>

{#snippet bar()}
  <FilterBar
    aria-label={TASK_COPY.filtersLabel}
    {segments}
    segmentValue={filter.status ?? 'all'}
    segmentsLabel={TASK_COPY.statusLabel}
    {facets}
    {appliedFilters}
    foldOrder={FOLD_ORDER}
    searchQuery={typed}
    searchPlaceholder={TASK_COPY.list.searchPlaceholder}
    searchAriaLabel={TASK_COPY.list.searchLabel}
    onSegmentChange={(value) => change({ status: value === 'all' ? '' : value })}
    onSearchChange={search}
    onFacetChange={(key, value) => change({ [key]: value })}
    onFilterRemove={(key) => change({ [key]: '' })}
  />
{/snippet}

<section class="ib-runs ib-records" aria-label={TASK_COPY.listHeading} data-page="runs">
  <!-- While the server gives no answer the shell draws its banner above the page; this region is
       how the header's "+" and the first-use state's Start run join the controls it holds. -->
  <StaleRegion stale={connection.unreachable} reason={CONNECTION_COPY.changesOff}>
    <!-- Starting a run needs no list, so the "+" stays live while the list loads (row 14m). Under a
         full error state it is drawn muted (inert, with its reason as its description), so Try again
         is the one strong action (row 53b). -->
    <PageHeader
      title={TASK_COPY.listHeading}
      description={TASK_COPY.list.description}
      headingLevel={1}
      error={failed}
      createAction={{
        label: TASK_COPY.startRun,
        href: router.href(START_RUN_PATH),
        onclick: (event: MouseEvent) => open(event, START_RUN_PATH),
        ...(failed ? { inertReason: TASK_COPY.list.loadFailed.startOffReason } : {}),
      }}
    />

    {#if !failed && !firstUse && (!loading || showCanceled || filterBarRevealed)}
      {@render bar()}
    {/if}

    {#if failed}
      <ErrorState
        bordered
        title={TASK_COPY.list.loadFailed.title}
        description={failure.description}
        detail={failure.detail}
        headingLevel={2}
        retryLabel={RETRY_LABEL}
        onRetry={retry}
      >
        {#snippet secondaryAction()}
          <Button
            variant="secondary"
            href={router.href(TASK_COPY.list.loadFailed.healthPath)}
            onclick={(event) => open(event, TASK_COPY.list.loadFailed.healthPath)}
          >
            {TASK_COPY.list.loadFailed.checkHealth}
          </Button>
        {/snippet}
      </ErrorState>
    {:else if loading}
      <RunListStates
        kind={showCanceled ? 'canceled' : 'loading'}
        {now}
        {zone}
        onCancel={cancelLoading}
        onRetry={retry}
      />
    {:else if firstUse}
      <!-- The one list-page first use (owner report, 2026-11-19): Start run, and a chat beside it. -->
      <ListPageEmpty
        view="runs"
        title={TASK_COPY.empty.title}
        description={TASK_COPY.empty.description}
        create={{
          label: TASK_COPY.startRun,
          href: router.href(START_RUN_PATH),
          onclick: (event) => open(event, START_RUN_PATH),
        }}
        secondary={[
          {
            label: TASK_COPY.empty.chatAction,
            href: router.href(TASK_COPY.empty.chatPath),
            onclick: (event) => open(event, TASK_COPY.empty.chatPath),
          },
        ]}
      />
    {:else}
      {#if rows.length === 0}
        <EmptyState
          kind="filtered"
          title={TASK_COPY.noMatch.title}
          description={noMatch}
          headingLevel={2}
          clearFiltersLabel={TASK_COPY.clearAction}
          onClearFilters={clearFilters}
        />
      {:else}
        <div class="ib-runs__list" {@attach followLinks}>
          <DataList
            items={entries}
            key={(entry: RunListEntry) => entry.key}
            aria-label={TASK_COPY.list.rowsLabel}
            groupBy={(entry: RunListEntry) => runDayGroup(entry.at, now, zone)}
          >
            {#snippet children(entry: RunListEntry)}
              {#if entry.kind === 'run'}
                <RunListRow
                  row={entry.row}
                  {now}
                  {zone}
                  {agentLabel}
                  {pluginTitle}
                  {scheduleCadence}
                  {scheduleHolds}
                  phoneWidth="viewport"
                  readable={entry.row.engineRun !== true || engineReadable}
                />
              {:else}
                <MissedRunsRow missed={entry.missed} {zone} {agentLabel} />
              {/if}
            {/snippet}
          </DataList>
          {#if shownRuns < rows.length}
            <LoadMore
              hasMore
              loadedCount={shownRuns}
              totalCount={rows.length}
              buttonLabel={TASK_COPY.loadMore}
              endOfListMessage=""
              maxRetries={0}
              onLoadMore={showMore}
            />
          {/if}
        </div>
      {/if}
    {/if}
  </StaleRegion>
</section>
