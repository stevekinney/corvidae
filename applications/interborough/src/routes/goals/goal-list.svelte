<script lang="ts">
  /**
   * `/goals`: the caller's goals, ended ones included, as Cinder's status-first rows grouped under
   * their days, newest first (the days name the zone their times are in). A row is the goal's name
   * and the time it began on line one, with its status word ahead of it, and line two the agent,
   * the attempts bar with "N of M", and the check the goal runs (`goal-list-row.svelte`). The
   * segments (All, Running, Done, Gave up, Stopped) partition the list, and each carries its count;
   * "Agent" is a chip beside them. The address owns the filters, so a filtered list can be shared.
   * A row is one link to the goal, whose own page stops, edits and restarts it, so the rows carry no
   * actions. The header's "+" makes a goal, and opens `/goals/new`.
   *
   * The Bureau lists goals oldest first by offset, and each segment carries a count of its own, so
   * every goal is read once (`listAllGoals`) and narrowed here. The list reads itself again when
   * `bureau.events` reports a goal event, so a goal ends on screen as the Bureau ends it; while that
   * feed is not live and a goal has not ended, it reads itself again on a timer instead.
   *
   * The page keeps its header in every state, so it draws its own (`ownsStatesOnPatterns` in `app/views.ts`):
   * nothing yet is an empty state that is the page, with no filter bar and the one primary "New
   * goal"; filters that match nothing keep the filter bar over a "Clear filters" state; a read in
   * progress shows placeholders after 300 ms, and "Cancel" in its slow-load line stops it; a read
   * that failed with nothing to show is a full error state with the header's "+" inert, and one that
   * failed over old data is a banner under the header (the shared unreachable preset, with its
   * countdown, in place of the shell's, which leaves it to this page: `claimBanner`). The frame
   * still says whether the caller may see the view at all, forbidden or not. Owner scoping is the
   * gate, so the view holds no scope.
   */
  import {
    Banner,
    Button,
    DataList,
    EmptyState,
    ErrorState,
    FilterBar,
    PageHeader,
    StaleRegion,
    type AppliedFilter,
    type FacetDefinition,
  } from '@lostgradient/cinder';
  import { Plus, Search, Target } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import {
    CONNECTION_MAX_ATTEMPTS,
    ConnectionMonitor,
    connectionBannerPreset,
    getConnection,
  } from '../../app/connection.svelte.ts';
  import { CONNECTION_COPY, GOALS_COPY, RETRY_LABEL, VIEW_COPY } from '../../app/copy.ts';
  import { useBureauEventsLive } from '../../app/live-polling.svelte.ts';
  import { restartActivity } from '../../app/restart/host-restart-flow.svelte.ts';
  import { useAgentDisplayName } from '../../lib/agent-display-name.svelte.ts';
  import { goalHasEnded, listAllGoals, type Goal } from '../../lib/bureau-goals.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { viewerTimeZone } from '../../lib/format/clock.ts';
  import { phoneViewport } from '../../lib/phone-viewport.svelte.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import GoalListLoading from './goal-list-loading.svelte';
  import GoalListRow from './goal-list-row.svelte';
  import { goalsLoadFailure } from './goal-list-states.ts';
  import {
    GOAL_SEGMENT_LABELS,
    GOAL_SEGMENTS,
    countGoalRows,
    goalDayGroup,
    goalFiltersFromSearch,
    goalNoMatchDescription,
    goalRow,
    narrowByAgent,
    narrowBySegment,
    sortGoalRows,
    type GoalRow,
  } from './goal-rows.ts';

  /** The page that makes a goal. */
  const NEW_GOAL_PATH = '/goals/new';
  /** How often the list reads itself again while a goal has not ended and the Bureau's feed is not live. */
  const POLL_MS = 1_500;

  const queryClient = useQueryClient();
  const connection = getConnection();
  const agentLabel = useAgentDisplayName();
  const zone = viewerTimeZone();

  const filters = $derived(goalFiltersFromSearch(router.current.search));
  const phone = $derived(phoneViewport.current);

  /** Writes one filter into the address, and takes it out when it has no value. */
  function setFilter(key: string, value: string | undefined): void {
    const params = new URLSearchParams(router.current.search);
    if (value === undefined || value === '' || value === 'all') params.delete(key);
    else params.set(key, value);
    const query = params.toString();
    router.navigate(query ? `/goals?${query}` : '/goals', { replace: true });
  }

  function clearFilters(): void {
    router.navigate('/goals', { replace: true });
  }

  function newGoal(): void {
    router.navigate(NEW_GOAL_PATH);
  }

  // Every goal is read once and narrowed here, because each segment carries a count of its own.
  const bureauLive = useBureauEventsLive();
  const goals = createQuery(() => {
    // Read here, not in the interval below, which TanStack calls on its own and so is not tracked.
    const polling = !bureauLive();
    return {
      queryKey: queryKeys.goals.list(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listAllGoals({ signal }),
      retry: false,
      // poll-reason: fallback
      refetchInterval: (query: { state: { data: Goal[] | undefined } }) =>
        polling && (query.state.data ?? []).some((goal) => !goalHasEnded(goal.status))
          ? POLL_MS
          : false,
    };
  }, undefined);

  // "Cancel" in the "Still loading" line stops the first read, and "Try again" reads again.
  // TanStack puts a first read that is cancelled back to pending, so the page keeps what it was
  // told here.
  let loadStopped = $state(false);

  function stopLoading(): void {
    loadStopped = true;
    void queryClient.cancelQueries({ queryKey: queryKeys.goals.list() });
  }

  function readAgain(): void {
    loadStopped = false;
    void goals.refetch();
  }

  // A read that failed with nothing to show replaces the list; one that failed over goals already
  // read leaves them in place under a banner, which counts down to the next try the way the shell's
  // does for a server that gives no answer.
  const failedFirstLoad = $derived(goals.isError && goals.data === undefined);
  const refetchFailed = $derived(goals.isRefetchError && goals.data !== undefined);
  const failure = $derived(failedFirstLoad ? goalsLoadFailure(goals.error) : undefined);
  const stopped = $derived(goals.isPending && loadStopped);

  /** Reads the list again, and the frame's own probe of it, so what the frame says follows. */
  function retry(): void {
    void goals.refetch();
    void queryClient.refetchQueries({ queryKey: queryKeys.view('goals', null) });
  }

  // The tries after a failed refresh back off and count, as the connection's do.
  const refreshTries = new ConnectionMonitor({
    probe: async () => {
      const result = await goals.refetch();
      if (result.isError) throw result.error;
    },
    browserOffline: false,
  });
  $effect(() => {
    if (refetchFailed) untrack(() => refreshTries.reportUnreachable());
    else untrack(() => refreshTries.reportReachable());
  });
  $effect(() => () => refreshTries.dispose());
  // The shell leaves its banner to this page while it is on screen.
  $effect(() => connection.claimBanner());

  /** Banner's Retry now: the connection's own tries again, or this read's, and the frame's probe of it. */
  function retryNow(): void {
    if (connection.unreachable) {
      void connection.retryNow();
      return;
    }
    void refreshTries.retryNow();
    void queryClient.refetchQueries({ queryKey: queryKeys.view('goals', null) });
  }

  /** The server gives no answer, or this read failed after it had shown goals. */
  const stale = $derived(!failedFirstLoad && (connection.unreachable || refetchFailed));
  /** What counts the banner: the connection's own tries, or the refresh's. */
  const tries = $derived(connection.unreachable ? connection : refreshTries);

  // The clock the days are counted from, read again whenever the goals are.
  const now = $derived.by(() => {
    void goals.dataUpdatedAt;
    return Date.now();
  });

  /** One row of each goal, newest first. */
  const allRows = $derived(sortGoalRows((goals.data ?? []).map(goalRow)));
  const facetRows = $derived(narrowByAgent(allRows, filters.agent));
  const counts = $derived(countGoalRows(facetRows));
  const visibleRows = $derived(narrowBySegment(facetRows, filters.status));

  const segments = $derived(
    GOAL_SEGMENTS.map((value) => ({
      value,
      label: GOAL_SEGMENT_LABELS[value],
      count: counts[value],
    })),
  );

  const agentOptions = $derived(
    [
      ...new Set([
        ...allRows.map((row) => row.agentName),
        ...(filters.agent === undefined ? [] : [filters.agent]),
      ]),
    ]
      .map((name) => ({ value: name, label: agentLabel(name) }))
      .toSorted((left, right) => left.label.localeCompare(right.label)),
  );
  const facets = $derived<FacetDefinition[]>([
    {
      type: 'choice',
      key: 'agent',
      label: GOALS_COPY.agentLabel,
      multiple: false,
      options: agentOptions,
    },
  ]);
  const appliedFilters = $derived<AppliedFilter[]>(
    filters.agent === undefined
      ? []
      : [{ key: 'agent', value: filters.agent, label: GOALS_COPY.agentLabel }],
  );

  function rowKey(row: GoalRow): string {
    return row.id;
  }

  // Nothing to list at all, as opposed to filters that match nothing.
  const nothingYet = $derived(allRows.length === 0);
  const noMatchSentence = $derived(
    goalNoMatchDescription(filters, {
      agent: filters.agent === undefined ? undefined : agentLabel(filters.agent),
    }),
  );
  const newActionReason = $derived(failedFirstLoad ? GOALS_COPY.newActionOffReason : undefined);
</script>

<section class="ib-records" aria-label={VIEW_COPY.goals.label} data-page="goals">
  <!-- While the server gives no answer the shell holds every control that changes something; this
       region is how the header's "+" (and the empty state's button) join them. -->
  <StaleRegion stale={stale || connection.unreachable} reason={CONNECTION_COPY.changesOff}>
    <PageHeader
      title={VIEW_COPY.goals.label}
      description={GOALS_COPY.subtitle}
      headingLevel={1}
      error={failedFirstLoad}
      createAction={{
        label: GOALS_COPY.newAction,
        onclick: newGoal,
        ...(newActionReason === undefined ? {} : { inertReason: newActionReason }),
      }}
    />

    <!-- While the host restarts, the restart dialog is the one account of it, as in the shell. -->
    {#if stale && !restartActivity.active}
      <Banner
        preset={connectionBannerPreset(tries)}
        dataUpdatedAt={connection.unreachable ? connection.lastHealthyAt : goals.dataUpdatedAt}
        retryInSeconds={tries.retryInSeconds}
        attempt={tries.browserOffline || tries.attempt === 0 ? undefined : tries.attempt}
        maxAttempts={CONNECTION_MAX_ATTEMPTS}
        onRetry={retryNow}
      />
    {/if}

    {#if failedFirstLoad && failure !== undefined}
      <div {@attach followLinks}>
        <ErrorState
          bordered
          headingLevel={2}
          title={failure.title}
          description={failure.description}
          {...failure.detail === undefined ? {} : { detail: failure.detail }}
          retryLabel={RETRY_LABEL}
          onRetry={retry}
        >
          {#snippet secondaryAction()}
            <Button variant="secondary" href={router.href(GOALS_COPY.failed.openHealthPath)}
              >{GOALS_COPY.failed.openHealth}</Button
            >
          {/snippet}
        </ErrorState>
      </div>
    {:else if stopped}
      <ErrorState
        bordered
        headingLevel={2}
        tone="neutral"
        title={GOALS_COPY.stopped.title}
        description={GOALS_COPY.stopped.description}
        retryLabel={RETRY_LABEL}
        retryVariant="secondary"
        onRetry={readAgain}
      />
    {:else if goals.isPending}
      <GoalListLoading
        {segments}
        segmentValue={filters.status}
        {facets}
        {appliedFilters}
        onSegmentChange={(value) => setFilter('status', value)}
        onFacetChange={setFilter}
        onFilterRemove={(key) => setFilter(key, undefined)}
        onCancel={stopLoading}
      />
    {:else if nothingYet}
      <EmptyState
        bordered
        kind="first-use"
        title={GOALS_COPY.empty.title}
        description={GOALS_COPY.empty.description}
        headingLevel={2}
      >
        {#snippet icon()}<Target aria-hidden="true" />{/snippet}
        {#snippet action()}
          <Button variant="primary" label={GOALS_COPY.newAction} onclick={newGoal} mutating>
            {#snippet leadingIcon()}<Plus />{/snippet}
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      <FilterBar
        aria-label={GOALS_COPY.filtersLabel}
        searchVisible={false}
        {segments}
        segmentValue={filters.status}
        {facets}
        {appliedFilters}
        onSegmentChange={(value) => setFilter('status', value)}
        onFacetChange={setFilter}
        onFilterRemove={(key) => setFilter(key, undefined)}
      />

      {#if visibleRows.length === 0}
        <EmptyState
          bordered
          kind="filtered"
          title={GOALS_COPY.noMatch.title}
          description={noMatchSentence}
          headingLevel={2}
          clearFiltersLabel={GOALS_COPY.clearAction}
          onClearFilters={clearFilters}
        >
          {#snippet icon()}<Search aria-hidden="true" />{/snippet}
        </EmptyState>
      {:else}
        <div {@attach followLinks}>
          <DataList
            items={visibleRows}
            key={rowKey}
            aria-label={GOALS_COPY.rowsLabel}
            groupBy={(row: GoalRow) => goalDayGroup(row, now, zone, phone)}
          >
            {#snippet children(row: GoalRow)}
              <GoalListRow {row} agent={agentLabel(row.agentName)} {zone} {phone} />
            {/snippet}
          </DataList>
        </div>
      {/if}
    {/if}
  </StaleRegion>
</section>
