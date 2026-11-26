<script lang="ts">
  /**
   * `/checks`: what every check decided about the agents' work, newest first (COR-2114, the agreed
   * design). It is modelled on `/runs`, so a person who knows Runs already knows this page: a header,
   * one filter bar that never wraps (the Kind segments, with no counts, then the Check, Outcome,
   * Agent and Time chips, and no search), status-first two-line rows (`checks-row.svelte`) under day
   * bands that name the zone their times are in, and a Load more.
   *
   * The operation pages by a cursor and has no total, so there are no counts and no "Showing 10 of
   * 19": the footer is Load more alone, drawn only while the operation hands back a cursor, fifty
   * rows a load. The filters are the address's, so a filtered list can be shared; each one is sent to
   * `bureau.checks.list` (`checksQuery`), so the rows are the server's answer to it and never a
   * narrowing of what was loaded.
   *
   * The page keeps its header in every state, so it draws its own (`ownsStates` in `app/views.ts`):
   * nothing yet is an empty state with no filter bar; filters that match nothing keep the bar over a
   * Clear filters state; a read in progress shows placeholders after 300 ms (`checks-states.svelte`),
   * and once it is slow, a Cancel that leaves "Loading canceled" and Try again; a read that failed
   * with nothing to show is the full error state with no bar. A Load more that failed keeps every
   * row and says so in its own footer. A server that does not answer is the shell's banner, with the
   * rows on screen at full contrast. The frame still words a refusal (forbidden).
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
  import { createInfiniteQuery, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { getConnection } from '../../app/connection.svelte.ts';
  import ListPageEmpty from '../../app/list-page-empty.svelte';
  import {
    CHECK_SEGMENTS,
    CHECK_TIMES,
    CHECK_OUTCOME_WORDS,
    CHECKS_COPY,
  } from '../../app/copy/checks.ts';
  import { TASK_COPY } from '../../app/copy/tasks.ts';
  import { CONNECTION_COPY, RETRY_LABEL } from '../../app/copy/views.ts';
  import { agentLabel as agentLabelOf } from '../../lib/agent-label.ts';
  import { listAgents } from '../../lib/bureau-client.ts';
  import { listChecks, type CheckRow } from '../../lib/bureau-checks.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { faultErrorStateAdvice } from '../../lib/faults.ts';
  import { createBureauClient } from '../../lib/bureau-api.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { viewerTimeZone } from '../../lib/format/clock.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { getPrincipalStore, principalQueryScope } from '../../lib/scopes.svelte.ts';
  import { HOME_CLOCK_MILLISECONDS } from '../home/home-clock.svelte.ts';
  import { runListFailure } from '../workflows/runs/run-list-states.ts';
  import { filterLabelOf, runDayGroup } from '../workflows/runs/run-rows.ts';
  import ChecksRow from './checks-row.svelte';
  import {
    checkKey,
    checkOptions,
    checksAreFiltered,
    checksQuery,
    outcomesOffered,
    parseChecksFilter,
    serializeChecksFilter,
  } from './checks-rows.ts';
  import ChecksStates, { CHECKS_LOADING_DELAY_MILLISECONDS } from './checks-states.svelte';

  /** The page, so a Clear filters and a filter change stay on it. */
  const CHECKS_PATH = '/checks';

  const filter = $derived(parseChecksFilter(router.current.search));
  const filterKey = $derived(serializeChecksFilter(filter));
  const filtered = $derived(checksAreFiltered(filter));
  const queryClient = useQueryClient();
  const bureau = createBureauClient({ baseUrl: '' });
  const principal = getPrincipalStore();
  const queryScope = () => principalQueryScope(principal.principal);
  const connection = getConnection();

  // Fifty rows a read, from the cursor each answer hands back. The time preset reaches back from the
  // moment the read is made, and every page of one read shares it through the cursor.
  const results = createInfiniteQuery(
    () => ({
      queryKey: [...queryKeys.checks.list(filterKey), queryScope()],
      queryFn: ({ pageParam, signal }: { pageParam: string; signal: AbortSignal }) =>
        listChecks(
          bureau,
          checksQuery(filter, Date.now()),
          pageParam === '' ? undefined : pageParam,
          {
            signal,
          },
        ),
      initialPageParam: '',
      getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
      retry: false,
    }),
    undefined,
  );

  // The agents to filter by come from the catalog as well as the rows, so an agent with no result yet
  // can be chosen, and each is named as a person reads it.
  const agents = createQuery(
    () => ({
      queryKey: [...queryKeys.checks.agents(), queryScope()],
      queryFn: ({ signal }) => listAgents({ signal }, bureau),
      retry: false,
    }),
    undefined,
  );

  function agentLabel(agentName: string): string {
    return agentLabelOf(agentName, agents.data);
  }

  const rows = $derived(combinePages(results.data?.pages, (page) => page.checks, checkKey));
  const zone = viewerTimeZone();
  // The clock the day bands are counted to, read each minute.
  let now = $state(Date.now());
  $effect(() => {
    // poll-reason: clock
    const timer = setInterval(() => {
      now = Date.now();
    }, HOME_CLOCK_MILLISECONDS);
    return () => clearInterval(timer);
  });

  const failed = $derived(results.isError && results.data === undefined);
  const loading = $derived(results.isPending && !results.isError);
  const failure = $derived(
    runListFailure([{ operation: 'bureau.checks.list', error: failed ? results.error : null }]),
  );
  const firstUse = $derived(!loading && !failed && rows.length === 0 && !filtered);

  // The bar waits the same 300 ms the placeholders do, so a quick read never flashes either; once
  // it has been drawn it stays through a change of filter.
  let barRevealed = $state(false);
  $effect(() => {
    if (!results.isPending) {
      barRevealed = true;
      return;
    }
    // poll-reason: timer
    const timer = setTimeout(() => {
      barRevealed = true;
    }, CHECKS_LOADING_DELAY_MILLISECONDS);
    return () => clearTimeout(timer);
  });

  // Cancel, in the status line a slow read shows, gives the read up: the rows are replaced by
  // "Loading canceled" and Try again, and the header and the bar stay. A change of filter is a new
  // read, so it ends the cancellation.
  let canceledFor = $state<string | undefined>();
  const showCanceled = $derived(canceledFor === filterKey && results.isPending);
  function cancelLoading(): void {
    canceledFor = filterKey;
    void queryClient.cancelQueries({ queryKey: queryKeys.checks.list(filterKey) });
  }
  function retry(): void {
    canceledFor = undefined;
    void results.refetch();
  }

  const segments = $derived<FilterSegment[]>(
    CHECK_SEGMENTS.map((value) => ({ value, label: CHECKS_COPY.segments[value] })),
  );
  const agentNames = $derived(
    [
      ...new Set([
        ...(agents.data ?? []).map((agent) => agent.name),
        ...rows.flatMap((row) => (row.agentName === null ? [] : [row.agentName])),
        ...(filter.agent === undefined ? [] : [filter.agent]),
      ]),
    ].toSorted(),
  );
  const facets = $derived<FacetDefinition[]>([
    {
      type: 'choice',
      key: 'check',
      label: CHECKS_COPY.facets.check,
      multiple: false,
      options: checkOptions(rows, filter.check).map((option) => ({ ...option })),
    },
    {
      type: 'choice',
      key: 'outcome',
      label: CHECKS_COPY.facets.outcome,
      multiple: false,
      options: outcomesOffered(filter.segment).map((value) => ({
        value,
        label: CHECK_OUTCOME_WORDS[value],
      })),
    },
    {
      type: 'choice',
      key: 'agent',
      label: CHECKS_COPY.facets.agent,
      multiple: false,
      options: agentNames.map((name) => ({ value: name, label: filterLabelOf(agentLabel(name)) })),
    },
    {
      type: 'choice',
      key: 'time',
      label: CHECKS_COPY.facets.time,
      multiple: false,
      options: CHECK_TIMES.map((value) => ({ value, label: CHECKS_COPY.times[value] })),
    },
  ]);
  const appliedFilters = $derived<AppliedFilter[]>([
    ...(filter.check === undefined
      ? []
      : [{ key: 'check', value: filter.check, label: CHECKS_COPY.facets.check }]),
    ...(filter.outcome === undefined
      ? []
      : [{ key: 'outcome', value: filter.outcome, label: CHECKS_COPY.facets.outcome }]),
    ...(filter.agent === undefined
      ? []
      : [{ key: 'agent', value: filter.agent, label: CHECKS_COPY.facets.agent }]),
    ...(filter.time === undefined
      ? []
      : [{ key: 'time', value: filter.time, label: CHECKS_COPY.facets.time }]),
  ]);

  /**
   * Changes what the address holds. The result is read back through the parser, so a Kind that
   * cannot have the outcome the address holds drops it, and the address never names a filter the
   * page would not apply.
   */
  function change(next: Record<string, string>): void {
    const params = new URLSearchParams(filterKey);
    for (const [key, value] of Object.entries(next)) {
      if (value === '') params.delete(key);
      else params.set(key, value);
    }
    const query = serializeChecksFilter(parseChecksFilter(params));
    router.navigate(`${CHECKS_PATH}${query === '' ? '' : `?${query}`}`, { replace: true });
  }

  function clearFilters(): void {
    router.navigate(CHECKS_PATH, { replace: true });
  }

  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  async function loadMore(): Promise<void> {
    // The failure is the footer's: it keeps every row and offers Try again.
    await results.fetchNextPage({ throwOnError: true });
  }
</script>

{#snippet bar()}
  <FilterBar
    aria-label={CHECKS_COPY.filtersLabel}
    {segments}
    segmentValue={filter.segment}
    segmentsLabel={CHECKS_COPY.kindLabel}
    {facets}
    {appliedFilters}
    searchVisible={false}
    onSegmentChange={(value) => change({ kind: value === 'all' ? '' : value })}
    onFacetChange={(key, value) => change({ [key]: value })}
    onFilterRemove={(key) => change({ [key]: '' })}
  />
{/snippet}

<section class="ib-checks ib-records" aria-label={CHECKS_COPY.title} data-page="checks">
  <!-- While the server gives no answer the shell draws its banner above the page; this region is
       how the first-use state's New goal joins the controls it holds. -->
  <StaleRegion stale={connection.unreachable} reason={CONNECTION_COPY.changesOff}>
    <PageHeader
      title={CHECKS_COPY.title}
      description={CHECKS_COPY.description}
      headingLevel={1}
      error={failed}
    />

    {#if failed}
      <ErrorState
        bordered
        title={CHECKS_COPY.loadFailed.title}
        description={failure.description}
        detail={failure.detail}
        headingLevel={2}
        retryLabel={RETRY_LABEL}
        {...faultErrorStateAdvice(failure.fault, retry)}
      >
        {#snippet secondaryAction()}
          <Button
            variant="secondary"
            href={router.href(TASK_COPY.list.loadFailed.healthPath)}
            onclick={(event) => open(event, TASK_COPY.list.loadFailed.healthPath)}
            label={TASK_COPY.list.loadFailed.checkHealth}
          />
        {/snippet}
      </ErrorState>
    {:else if loading}
      {#if barRevealed || showCanceled}
        {@render bar()}
      {/if}
      <ChecksStates
        kind={showCanceled ? 'canceled' : 'loading'}
        onCancel={cancelLoading}
        onRetry={retry}
      />
    {:else if firstUse}
      <!-- The one list-page first use (owner report, 2026-11-19). A check is never made here, so the
           state's one action makes the goal whose check fills the list. -->
      <ListPageEmpty
        view="checks"
        title={CHECKS_COPY.empty.title}
        description={CHECKS_COPY.empty.description}
        create={{
          label: CHECKS_COPY.empty.action,
          href: router.href(CHECKS_COPY.empty.path),
          onclick: (event) => open(event, CHECKS_COPY.empty.path),
        }}
      />
    {:else}
      {@render bar()}

      {#if rows.length === 0}
        <EmptyState
          kind="filtered"
          title={CHECKS_COPY.noMatch.title}
          description={CHECKS_COPY.noMatch.description}
          headingLevel={2}
          clearFiltersLabel={CHECKS_COPY.clearAction}
          onClearFilters={clearFilters}
        />
      {:else}
        <div class="ib-checks__list" {@attach followLinks}>
          <DataList
            items={rows}
            key={checkKey}
            aria-label={CHECKS_COPY.rowsLabel}
            groupBy={(row: CheckRow) => runDayGroup(Date.parse(row.timestamp), now, zone)}
          >
            {#snippet children(row: CheckRow)}
              <ChecksRow {row} {zone} {agentLabel} />
            {/snippet}
          </DataList>
          {#if results.hasNextPage}
            <LoadMore
              hasMore
              loading={results.isFetchingNextPage}
              buttonLabel={CHECKS_COPY.loadMore}
              itemLabel={CHECKS_COPY.loadMoreItems}
              endOfListMessage=""
              maxRetries={0}
              onLoadMore={loadMore}
            />
          {/if}
        </div>
      {/if}
    {/if}
  </StaleRegion>
</section>
