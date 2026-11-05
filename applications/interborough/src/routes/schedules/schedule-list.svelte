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
   * Whether there is nothing to list, or the server is failing or refusing, is the view frame's to
   * say (`app/view-probes.ts`).
   */
  import {
    EmptyState,
    FilterBar,
    formatTimeZoneLabel,
    PageHeader,
    Skeleton,
    DataList,
    type AppliedFilter,
    type FacetDefinition,
  } from '@lostgradient/cinder';

  import type { ScheduleSummary } from '@lostgradient/weft';

  import { createQuery, keepPreviousData } from '@tanstack/svelte-query';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { phoneViewport } from '../../lib/phone-viewport.svelte.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, scheduleCreatePath } from '../../lib/router.svelte.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import FaultBanner from './fault-banner.svelte';
  import { OVERLAY_FAILURE } from './overlay-failure.ts';
  import { scheduleOverlayOptions } from './overlay-query.ts';
  import ScheduleListRow from './schedule-list-row.svelte';
  import {
    countRows,
    filtersFromSearch,
    isFiltered,
    narrowByFacets,
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
  const principal = getPrincipalStore();

  const filters = $derived(filtersFromSearch(router.current.search));

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

  // What the Bureau knows of these schedules: which start an agent, which agent, and the workflow
  // files. Until it answers a schedule is of no known kind.
  const overlay = createQuery(() => scheduleOverlayOptions(client));
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
    sortScheduleRows(rowsOf(modelAgents.data).filter((row) => row.status !== 'cancelled')),
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

  const zone = $derived(formatTimeZoneLabel(now, { style: 'long' }));
  const phone = $derived(phoneViewport.current);
</script>

<section class="ib-records" aria-label={SCHEDULE_COPY.title} data-page="schedules">
  <PageHeader
    title={SCHEDULE_COPY.title}
    description={SCHEDULE_COPY.subtitle(zone)}
    headingLevel={1}
    createAction={{
      label: SCHEDULE_COPY.newAction,
      onclick: () => router.navigate(scheduleCreatePath()),
      ...(writeGate.disabled && writeGate.title !== undefined
        ? { inertReason: writeGate.title }
        : {}),
    }}
  />

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

  {#if overlay.data?.failed}
    <FaultBanner treatment={OVERLAY_FAILURE} onRetry={() => void overlay.refetch()} />
  {/if}

  {#if listQuery.isPending}
    <div role="status" aria-busy="true" aria-label={SCHEDULE_COPY.loading}>
      <Skeleton height="3.5rem" />
      <Skeleton height="3.5rem" />
    </div>
  {:else if listQuery.isError}
    <FaultBanner
      treatment={faultTreatment(listQuery.error)}
      onRetry={() => void listQuery.refetch()}
    />
  {:else if visibleRows.length === 0 && isFiltered(filters)}
    <EmptyState
      kind="filtered"
      title={SCHEDULE_COPY.noMatch.title}
      description={SCHEDULE_COPY.noMatch.description}
      headingLevel={2}
      clearFiltersLabel={SCHEDULE_COPY.clearFilters}
      onClearFilters={clearFilters}
    />
  {:else}
    <div {@attach followLinks}>
      <DataList items={visibleRows} key={rowKey} statusColumn aria-label={SCHEDULE_COPY.rowsLabel}>
        {#snippet children(row)}
          <ScheduleListRow {row} {phone} />
        {/snippet}
      </DataList>
    </div>
  {/if}
</section>
