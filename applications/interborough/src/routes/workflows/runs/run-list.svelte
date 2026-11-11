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
   */
  import {
    Button,
    DataList,
    EmptyState,
    ErrorState,
    FilterBar,
    LoadMore,
    PageHeader,
    Skeleton,
    type AppliedFilter,
    type FacetDefinition,
    type FilterSegment,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { RETRY_LABEL, TASK_COPY } from '../../../app/copy.ts';
  import { useBureauEventsLive } from '../../../app/live-polling.svelte.ts';
  import { agentLabel as agentLabelOf } from '../../../lib/agent-label.ts';
  import { listAgents, listAllContexts } from '../../../lib/bureau-client.ts';
  import { listAllGoals } from '../../../lib/bureau-goals.ts';
  import { isRunning, listAllTasks } from '../../../lib/bureau-tasks.ts';
  import { followLinks } from '../../../lib/follow-links.ts';
  import { viewerTimeZone } from '../../../lib/format/clock.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { HOME_CLOCK_MILLISECONDS } from '../../home/home-clock.svelte.ts';
  import { REVIEW_POLL_MILLISECONDS } from '../../reviews/reviews-data.ts';
  import MissedRunsRow from './missed-runs-row.svelte';
  import { readRunSchedules } from './missed-runs.ts';
  import RunListRow from './run-list-row.svelte';
  import {
    buildRunRows,
    filterLabelOf,
    filterRunRows,
    parseRunFilter,
    RUN_PAGE_SIZE,
    RUN_SEGMENTS,
    runDayGroup,
    runListEntries,
    runListRows,
    runSegmentCounts,
    serializeRunFilter,
    type RunFilter,
    type RunListEntry,
  } from './run-rows.ts';
  import { STARTED_BY_KINDS, STARTED_BY_LABELS } from './started-by.ts';

  /** The form that starts a run. */
  const START_RUN_PATH = '/runs/new';
  /** How often a running run's duration is read again while one is on the list. */
  const RUNNING_CLOCK_MILLISECONDS = 1_000;
  const filter = $derived(parseRunFilter(router.current.search));

  // The queries below follow `bureau.events`: a run by `run.*` and `action`, a goal by `goal.*`,
  // a chat by `session.*` (`app/bureau-event-queries.ts`). Each asks again on a timer only while the
  // feed is not live, read in the option getter so the timer returns when the feed is lost.
  const bureauLive = useBureauEventsLive();
  // Every run, every page of them: the listing has no total, and the segments count all of them.
  const tasks = createQuery(() => {
    const polling = !bureauLive();
    return {
      queryKey: ['bureau-tasks', 'runs', 'all'] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => listAllTasks({}, { signal }),
      // A catalog run is announced by `run.settled` alone: no event says one has started, and
      // `run.removed` is not emitted for it (COR-1730), so a run still going shows only on the timer.
      // poll-reason: fallback
      refetchInterval: polling ? REVIEW_POLL_MILLISECONDS : false,
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
  const going = $derived(rows.some((row) => isRunning(row)));
  $effect(() => {
    const period = going ? RUNNING_CLOCK_MILLISECONDS : HOME_CLOCK_MILLISECONDS;
    // poll-reason: clock
    const timer = setInterval(() => {
      now = Date.now();
    }, period);
    return () => clearInterval(timer);
  });

  const agentNames = $derived(
    [
      ...new Set([
        ...(agents.data ?? []).map((agent) => agent.name),
        ...everyRun.flatMap((row) => (row.agentName === null ? [] : [row.agentName])),
        ...(filter.agent === undefined ? [] : [filter.agent]),
      ]),
    ].toSorted(),
  );

  const segments = $derived<FilterSegment[]>(
    RUN_SEGMENTS.map((value) => ({
      value,
      label: TASK_COPY.list.segments[value],
      count: tasks.data === undefined ? 'pending' : counts[value],
    })),
  );
  const facets = $derived<FacetDefinition[]>([
    {
      type: 'choice',
      key: 'startedBy',
      label: TASK_COPY.startedByLabel,
      multiple: false,
      options: STARTED_BY_KINDS.map((value) => ({ value, label: STARTED_BY_LABELS[value] })),
    },
    {
      type: 'choice',
      key: 'agent',
      label: TASK_COPY.agentLabel,
      multiple: false,
      options: agentNames.map((name) => ({ value: name, label: filterLabelOf(agentLabel(name)) })),
    },
  ]);
  const appliedFilters = $derived<AppliedFilter[]>([
    ...(filter.startedBy === undefined
      ? []
      : [{ key: 'startedBy', value: filter.startedBy, label: TASK_COPY.startedByLabel }]),
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
  // failing with nothing cached is a failed list, and Retry reads the ones that failed.
  const failed = $derived(
    (tasks.isError && tasks.data === undefined) ||
      (goals.isError && goals.data === undefined) ||
      (chats.isError && chats.data === undefined),
  );
  function retry(): void {
    if (tasks.isError) void tasks.refetch();
    if (goals.isError) void goals.refetch();
    if (chats.isError) void chats.refetch();
  }
  const loading = $derived(tasks.isPending || goals.isPending || chats.isPending);
  const firstUse = $derived(!loading && !failed && everyRun.length === 0);
</script>

<section class="ib-runs ib-records" aria-label={TASK_COPY.listHeading}>
  <PageHeader
    title={TASK_COPY.listHeading}
    description={TASK_COPY.list.description}
    headingLevel={1}
    createAction={{
      label: TASK_COPY.startRun,
      href: router.href(START_RUN_PATH),
      onclick: (event: MouseEvent) => open(event, START_RUN_PATH),
    }}
  />

  {#snippet startRun()}
    <Button
      href={router.href(START_RUN_PATH)}
      variant="primary"
      size="sm"
      onclick={(event) => open(event, START_RUN_PATH)}>{TASK_COPY.startRun}</Button
    >
  {/snippet}

  {#if !failed && !firstUse}
    <FilterBar
      aria-label={TASK_COPY.filtersLabel}
      {segments}
      segmentValue={filter.status ?? 'all'}
      segmentsLabel={TASK_COPY.statusLabel}
      {facets}
      {appliedFilters}
      searchQuery={typed}
      searchPlaceholder={TASK_COPY.list.searchPlaceholder}
      searchAriaLabel={TASK_COPY.list.searchLabel}
      onSegmentChange={(value) => change({ status: value === 'all' ? '' : value })}
      onSearchChange={search}
      onFacetChange={(key, value) => change({ [key]: value })}
      onFilterRemove={(key) => change({ [key]: '' })}
    />
  {/if}

  {#if loading}
    <div role="status" aria-busy="true" aria-label={TASK_COPY.loading}>
      <Skeleton height="3.5rem" />
      <Skeleton height="3.5rem" />
    </div>
  {:else if failed}
    <ErrorState
      variant="flat"
      title={TASK_COPY.loadFailed.title}
      description={TASK_COPY.loadFailed.description}
      headingLevel={2}
      retryLabel={RETRY_LABEL}
      onRetry={retry}
    />
  {:else if rows.length === 0 && filtered}
    <EmptyState
      kind="filtered"
      title={TASK_COPY.noMatch.title}
      description={TASK_COPY.noMatch.description}
      headingLevel={2}
      clearFiltersLabel={TASK_COPY.clearAction}
      onClearFilters={clearFilters}
    />
  {:else if rows.length === 0}
    <EmptyState
      kind="first-use"
      title={TASK_COPY.empty.title}
      description={TASK_COPY.empty.description}
      headingLevel={2}
    >
      {#snippet action()}{@render startRun()}{/snippet}
    </EmptyState>
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
            <RunListRow row={entry.row} {now} {zone} {agentLabel} />
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
</section>
