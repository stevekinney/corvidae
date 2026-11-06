<script lang="ts">
  /**
   * `/schedules`: every schedule, whichever way it was made (the Bureau's schedules that run an
   * agent, the engine's that start a workflow defined in code, and the trigger in an agent-authored
   * workflow's file), as Cinder's status-first two-line rows. A row is a status word, a bold title
   * and the next run on line one, and line two kind first (`Workflow · Chat with an agent ·
   * Assistant · Every day at 3:00 AM (9:00 AM UTC) · Last run Oct 29`). A schedule that missed runs
   * sorts first, and a reason a schedule will not start comes straight after the kind. The segments
   * (All, Active, Paused) partition the list, and "Missed runs" is a chip beside them, because a
   * schedule can be both Active and missed. The address owns the filters, so a filtered list can be
   * shared. A row is one link to the schedule, whose own page pauses, edits and deletes it, so the
   * rows carry no actions. The header's "+" makes a schedule, and is gated on `schedules:write`.
   *
   * The page keeps its header in every state, so it draws its own (`ownsStates` in `app/views.ts`):
   * nothing yet is an empty state that is the page, with no filter bar and the one primary "New
   * schedule"; filters that match nothing keep the filter bar over a "Clear filters" state; a read
   * in progress shows placeholders after 300 ms; a read that failed with nothing to show is a full
   * error state with the header's "+" inert, and one that failed over old data is a banner above
   * the rows. The frame still says whether the caller may see the view at all, forbidden or not.
   */
  import {
    Banner,
    Button,
    EmptyState,
    ErrorState,
    FilterBar,
    formatTimeZoneLabel,
    PageHeader,
    DataList,
    StaleRegion,
    type AppliedFilter,
    type FacetDefinition,
  } from '@lostgradient/cinder';
  import { Calendar, Plus, Search } from '@lucide/svelte';

  import type { ScheduleSummary } from '@lostgradient/weft';

  import { createQuery, keepPreviousData, useQueryClient } from '@tanstack/svelte-query';

  import { getConnection } from '../../app/connection.svelte.ts';
  import { CONNECTION_COPY, RETRY_LABEL, SCHEDULE_COPY } from '../../app/copy.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { getClient } from '../../lib/client.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { phoneViewport } from '../../lib/phone-viewport.svelte.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, scheduleCreatePath } from '../../lib/router.svelte.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import FaultBanner from './fault-banner.svelte';
  import { OVERLAY_FAILURE } from './overlay-failure.ts';
  import { useScheduleOverlay } from './overlay-query.svelte.ts';
  import ScheduleListLoading from './schedule-list-loading.svelte';
  import ScheduleListRow from './schedule-list-row.svelte';
  import {
    countRows,
    filtersFromSearch,
    narrowByFacets,
    noMatchDescription,
    narrowByView,
    type ScheduleSegment,
  } from './schedule-list-filters.ts';
  import { fetchScheduleList } from './schedule-queries.ts';
  import {
    loadModelAgents,
    loadScheduleRowSources,
    loadWorkflowAgents,
  } from './schedule-row-context.ts';
  import {
    scheduleRowOf,
    sortScheduleRows,
    typesNeedingSavedSteps,
    type ScheduleRow,
  } from './schedule-row-model.ts';

  const client = getClient();
  const queryClient = useQueryClient();
  const principal = getPrincipalStore();
  const connection = getConnection();

  const filters = $derived(filtersFromSearch(router.current.search));
  const phone = $derived(phoneViewport.current);

  /** Writes one filter into the address, and takes it out when it has no value. */
  function setFilter(key: string, value: string | undefined): void {
    const params = new URLSearchParams(router.current.search);
    if (value === undefined || value === '' || value === 'all') params.delete(key);
    else params.set(key, value);
    const query = params.toString();
    router.navigate(query ? `/schedules?${query}` : '/schedules', { replace: true });
  }

  function clearFilters(): void {
    router.navigate('/schedules', { replace: true });
  }

  const readGate = $derived(scopeGate(principal, ['schedules:read']));
  const writeGate = $derived(scopeGate(principal, ['schedules:write']));
  // Every schedule is read once and narrowed here, because each segment carries a count of its own.
  const listQuery = createQuery(() => ({
    queryKey: queryKeys.schedules.list({}),
    queryFn: () => fetchScheduleList(client, {}),
    enabled: !readGate.disabled,
  }));

  // A read that failed with nothing to show replaces the list; one that failed over schedules
  // already read leaves them in place under a banner. A server that gives no answer at all is the
  // shell's to say, in its own banner above the page, which also holds the header's "+".
  const failedFirstLoad = $derived(listQuery.isError && listQuery.data === undefined);
  const refreshFailed = $derived(
    listQuery.isRefetchError && listQuery.data !== undefined && !connection.unreachable,
  );

  /** Reads the list again, and the frame's own probe of it, so what the frame says follows. */
  function retry(): void {
    void listQuery.refetch();
    void queryClient.refetchQueries({ queryKey: queryKeys.view('schedules', null) });
  }

  // What the Bureau knows of these schedules: which start an agent, which agent, and the workflow
  // files. Until it answers a schedule is of no known kind.
  const overlay = useScheduleOverlay(client, connection);
  const sources = createQuery(() => ({
    queryKey: queryKeys.schedules.rowContext(),
    queryFn: ({ signal }) => loadScheduleRowSources(client, { signal }),
    retry: false,
  }));

  const schedules = $derived<readonly ScheduleSummary[]>(listQuery.data?.items ?? []);

  // The workflows whose file cannot load or is gone have no steps of their own to say which agent
  // they run, so the last saved version does.
  const savedStepTypes = $derived(
    typesNeedingSavedSteps(schedules, {
      overlay: overlay.data,
      definitionNames: sources.data?.definitionNames,
    }),
  );
  const workflowAgents = createQuery(() => ({
    queryKey: queryKeys.schedules.workflowAgents(savedStepTypes),
    queryFn: ({ signal }) => loadWorkflowAgents(savedStepTypes, { signal }),
    enabled: savedStepTypes.length > 0,
    // The agents read so far stay while the next set loads, so a row never loses a reason it had.
    placeholderData: keepPreviousData,
    retry: false,
  }));

  // The clock the next runs are counted from, read again whenever the schedules are.
  const now = $derived.by(() => {
    void listQuery.dataUpdatedAt;
    return Date.now();
  });
  /** One row of each schedule, from everything read so far. */
  function rowsOf(modelAgents: ReadonlySet<string> | undefined): ScheduleRow[] {
    return schedules.map((schedule) =>
      scheduleRowOf(schedule, {
        overlay: overlay.data,
        agents: sources.data?.agents,
        attention: sources.data?.attention,
        definitionNames: sources.data?.definitionNames,
        modelAgents,
        workflowAgents: workflowAgents.data ?? new Map(),
        now,
      }),
    );
  }

  // The agents the rows name are known once the rows are, and which of them need a model is read
  // from their definitions, so the rows are made twice: once to learn the agents, and again with
  // what is known of them.
  const usedAgentIds = $derived(
    [...new Set(rowsOf(undefined).flatMap((row) => row.agentIds))].toSorted(),
  );
  const modelAgents = createQuery(() => ({
    queryKey: queryKeys.schedules.modelAgents(usedAgentIds),
    queryFn: ({ signal }) => loadModelAgents(usedAgentIds, { signal }),
    enabled: usedAgentIds.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
  }));
  // A cancelled schedule has no segment, so it is not listed.
  const allRows = $derived(
    sortScheduleRows(
      rowsOf(modelAgents.data).filter((row) => row.status !== 'cancelled'),
      { phone },
    ),
  );

  const facetRows = $derived(narrowByFacets(allRows, filters));
  const counts = $derived(countRows(facetRows));
  const visibleRows = $derived(narrowByView(facetRows, filters));

  const segments = $derived([
    { value: 'all', label: SCHEDULE_COPY.segments.all, count: counts.all },
    { value: 'active', label: SCHEDULE_COPY.segments.active, count: counts.active },
    { value: 'paused', label: SCHEDULE_COPY.segments.paused, count: counts.paused },
  ]);

  const agentOptions = $derived(
    [
      ...new Set([
        ...allRows.flatMap((row) => row.agentIds),
        ...(filters.agent === undefined ? [] : [filters.agent]),
      ]),
    ]
      .map((id) => ({ value: id, label: agentLabel(id, sources.data?.agents) }))
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  );
  const workflowOptions = $derived.by(() => {
    const types = new Map<string, string>();
    for (const row of allRows) types.set(row.workflowType, row.workflowLabel);
    if (filters.workflow !== undefined && !types.has(filters.workflow)) {
      types.set(filters.workflow, filters.workflow);
    }
    return [...types]
      .map(([value, label]) => ({ value, label }))
      .toSorted((a, b) => a.label.localeCompare(b.label));
  });

  const facets = $derived<FacetDefinition[]>([
    {
      type: 'toggle',
      key: 'missed',
      label: SCHEDULE_COPY.missedRunsFilter,
      count: counts.missed,
      tone: 'warning',
    },
    {
      type: 'choice',
      key: 'agent',
      label: SCHEDULE_COPY.agentLabel,
      multiple: false,
      options: agentOptions,
    },
    {
      type: 'choice',
      key: 'workflow',
      label: SCHEDULE_COPY.workflowLabel,
      multiple: false,
      options: workflowOptions,
    },
  ]);
  const appliedFilters = $derived<AppliedFilter[]>([
    ...(filters.missed
      ? [{ key: 'missed', value: 'On', label: SCHEDULE_COPY.missedRunsFilter }]
      : []),
    ...(filters.agent === undefined
      ? []
      : [{ key: 'agent', value: filters.agent, label: SCHEDULE_COPY.agentLabel }]),
    ...(filters.workflow === undefined
      ? []
      : [{ key: 'workflow', value: filters.workflow, label: SCHEDULE_COPY.workflowLabel }]),
  ]);

  function changeFacet(key: string, value: string): void {
    if (key === 'missed') setFilter('missed', value === '' ? undefined : '1');
    else setFilter(key, value);
  }

  function rowKey(row: ScheduleRow): string {
    return row.id;
  }

  // Nothing to list at all, as opposed to filters that match nothing. A cancelled schedule is not
  // listed, so a list of only those is as empty as one with none.
  const nothingYet = $derived(allRows.length === 0);
  const noMatchSentence = $derived(
    noMatchDescription(filters, {
      agent:
        filters.agent === undefined ? undefined : agentLabel(filters.agent, sources.data?.agents),
      workflow:
        filters.workflow === undefined
          ? undefined
          : workflowOptions.find((option) => option.value === filters.workflow)?.label,
    }),
  );
  const newActionReason = $derived(
    failedFirstLoad ? SCHEDULE_COPY.newActionOffReason : writeGate.title,
  );

  const zone = $derived(formatTimeZoneLabel(now, { style: 'long' }));
</script>

<section class="ib-records" aria-label={SCHEDULE_COPY.title} data-page="schedules">
  <!-- While the server gives no answer the shell holds every control that changes something; this
       region is how the header's "+" (and the empty state's button) join them. -->
  <StaleRegion stale={connection.unreachable} reason={CONNECTION_COPY.changesOff}>
    <PageHeader
      title={SCHEDULE_COPY.title}
      description={SCHEDULE_COPY.subtitle(zone)}
      headingLevel={1}
      error={failedFirstLoad}
      createAction={{
        label: SCHEDULE_COPY.newAction,
        onclick: () => router.navigate(scheduleCreatePath()),
        ...((writeGate.disabled || failedFirstLoad) && newActionReason !== undefined
          ? { inertReason: newActionReason }
          : {}),
      }}
    />

    {#if refreshFailed}
      <Banner preset="refresh-failed" dataUpdatedAt={listQuery.dataUpdatedAt} onRetry={retry} />
    {/if}

    {#if failedFirstLoad}
      <ErrorState
        bordered
        title={SCHEDULE_COPY.loadFailed.title}
        description={SCHEDULE_COPY.loadFailed.description}
        headingLevel={2}
        retryLabel={RETRY_LABEL}
        onRetry={retry}
      />
    {:else if listQuery.isPending}
      <ScheduleListLoading
        {segments}
        segmentValue={filters.status}
        {facets}
        {appliedFilters}
        onSegmentChange={(value) => setFilter('status', value as ScheduleSegment)}
        onFacetChange={changeFacet}
        onFilterRemove={(key) => setFilter(key, undefined)}
      />
    {:else if nothingYet}
      <EmptyState
        bordered
        kind="first-use"
        title={SCHEDULE_COPY.empty.title}
        description={SCHEDULE_COPY.empty.description}
        headingLevel={2}
      >
        {#snippet icon()}<Calendar aria-hidden="true" />{/snippet}
        {#snippet action()}
          <Button
            variant="primary"
            label={SCHEDULE_COPY.newAction}
            aria-disabled={writeGate.disabled ? 'true' : undefined}
            title={writeGate.title}
            onclick={() => router.navigate(scheduleCreatePath())}
            mutating
          >
            {#snippet leadingIcon()}<Plus />{/snippet}
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      <FilterBar
        aria-label={SCHEDULE_COPY.filtersLabel}
        searchVisible={false}
        {segments}
        segmentValue={filters.status}
        {facets}
        {appliedFilters}
        onSegmentChange={(value) => setFilter('status', value as ScheduleSegment)}
        onFacetChange={changeFacet}
        onFilterRemove={(key) => setFilter(key, undefined)}
      />

      {#if overlay.failed}
        <FaultBanner treatment={OVERLAY_FAILURE} onRetry={overlay.refetch} />
      {/if}

      {#if visibleRows.length === 0}
        <EmptyState
          bordered
          kind="filtered"
          title={SCHEDULE_COPY.noMatch.title}
          description={noMatchSentence}
          headingLevel={2}
          clearFiltersLabel={SCHEDULE_COPY.clearFilters}
          onClearFilters={clearFilters}
        >
          {#snippet icon()}<Search aria-hidden="true" />{/snippet}
        </EmptyState>
      {:else}
        <div {@attach followLinks}>
          <DataList
            items={visibleRows}
            key={rowKey}
            statusColumn
            aria-label={SCHEDULE_COPY.rowsLabel}
          >
            {#snippet children(row)}
              <ScheduleListRow {row} {phone} />
            {/snippet}
          </DataList>
        </div>
      {/if}
    {/if}
  </StaleRegion>
</section>
