<script lang="ts">
  /**
   * `/runs`: what the agents have done, newest first, in the words of a task (`run-rows.ts`), as a
   * table with a column for each filter: which agent ran, what started it, how it stands, when, and
   * how long it took. The toolbar under the heading is the records toolbar: the count, the filters
   * (status, agent, what started it, how recently), which are the address's so a filtered list can
   * be shared, and Start run. A list the filters leave empty says so and offers Clear filters. The
   * engine's own table of workflows is the Health area's; it is not here.
   */
  import {
    Button,
    EmptyState,
    ErrorState,
    FilterBar,
    PageHeader,
    Skeleton,
    Table,
  } from '@lostgradient/cinder';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, TASK_COPY } from '../../../app/copy.ts';
  import { useBureauEventsLive } from '../../../app/live-polling.svelte.ts';
  import { useAgentDisplayName } from '../../../lib/agent-display-name.svelte.ts';
  import { listAgents, listAllContexts } from '../../../lib/bureau-client.ts';
  import { listAllGoals } from '../../../lib/bureau-goals.ts';
  import { listTasks, loadMoreTasks } from '../../../lib/bureau-tasks.ts';
  import { combinePages } from '../../../lib/combine-pages.ts';
  import { formatDuration, formatRelativeTime } from '../../../lib/format/index.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router, workflowDetailPath } from '../../../lib/router.svelte.ts';
  import { taskStatusWord } from '../../../lib/status.ts';
  import StatusLabel from '../../../lib/status-label.svelte';
  import { TASK_STATE_ORDER } from '../../../lib/task-status.ts';
  import RecordsToolbar from '../../../app/records/records-toolbar.svelte';
  import { REVIEW_POLL_MILLISECONDS } from '../../reviews/reviews-data.ts';
  import RunOrigin from './run-origin.svelte';
  import { STARTED_BY_LABELS } from './started-by.ts';
  import {
    buildRunRows,
    filterRunRows,
    parseRunFilter,
    serializeRunFilter,
    SINCE_RANGES,
  } from './run-rows.ts';

  const PAGE_SIZE = 100;
  /** The form that starts a run. */
  const START_RUN_PATH = '/runs?view=start';
  const filter = $derived(parseRunFilter(router.current.search));

  // The status and the agent are asked of the Bureau, so a page holds the runs that match and Load
  // more goes on from there. "Working" is two of the Bureau's states (a submitted task is working
  // too), so it is narrowed here instead. The rest (what started a run, how recently) the Bureau
  // cannot narrow, and are applied to what the pages hold.
  const serverStatus = $derived(filter.status === 'working' ? undefined : filter.status);
  // The three queries below follow `bureau.events`: a run by `run.*` and `action`, a goal by `goal.*`,
  // a chat by `session.*` (`app/bureau-event-queries.ts`). Each asks again on a timer only while the
  // feed is not live, read in the option getter so the timer returns when the feed is lost.
  const bureauLive = useBureauEventsLive();
  const tasks = createInfiniteQuery(() => {
    const polling = !bureauLive();
    return {
      queryKey: ['bureau-tasks', 'runs', serverStatus ?? '', filter.agent ?? ''] as const,
      queryFn: ({ pageParam, signal }: { pageParam: string; signal: AbortSignal }) =>
        listTasks(
          {
            limit: PAGE_SIZE,
            ...(serverStatus === undefined ? {} : { status: serverStatus }),
            ...(filter.agent === undefined ? {} : { agentName: filter.agent }),
            ...(pageParam === '' ? {} : { pageToken: pageParam }),
          },
          { signal },
        ),
      initialPageParam: '',
      getNextPageParam: (last: Awaited<ReturnType<typeof listTasks>>) =>
        last.nextPageToken ?? undefined,
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
  // The agents to filter by come from the catalog, because the runs on screen are already narrowed
  // to the agent chosen and would leave nothing else to choose.
  const agentLabel = useAgentDisplayName();
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

  const everyRun = $derived(
    buildRunRows({
      tasks: combinePages(
        tasks.data?.pages,
        (page) => page.tasks,
        (task) => task.id,
      ),
      goals: goals.data ?? [],
      chats: chats.data ?? [],
    }),
  );
  const rows = $derived(filterRunRows(everyRun, filter, Date.now()));
  const agentNames = $derived(
    [
      ...new Set([
        ...(agents.data ?? []).map((agent) => agent.name),
        ...everyRun.flatMap((row) => (row.agentName === null ? [] : [row.agentName])),
        ...(filter.agent === undefined ? [] : [filter.agent]),
      ]),
    ].toSorted(),
  );

  // "Working" is two of the Bureau's states, and one word: Running. Its filter is the state the
  // address names (`working`), and the Bureau's own `submitted` is narrowed in with it.
  const facets = $derived([
    {
      type: 'select' as const,
      key: 'status',
      label: TASK_COPY.statusLabel,
      placeholder: TASK_COPY.anyStatus,
      options: TASK_STATE_ORDER.map((state) => ({
        value: state,
        label: statusWordOf(state),
      })),
    },
    {
      type: 'select' as const,
      key: 'agent',
      label: TASK_COPY.agentLabel,
      placeholder: TASK_COPY.anyAgent,
      options: agentNames.map((name) => ({ value: name, label: agentLabel(name) })),
    },
    {
      type: 'select' as const,
      key: 'startedBy',
      label: TASK_COPY.startedByLabel,
      placeholder: TASK_COPY.anyOrigin,
      options: Object.entries(STARTED_BY_LABELS).map(([value, label]) => ({ value, label })),
    },
    {
      type: 'select' as const,
      key: 'since',
      label: TASK_COPY.sinceLabel,
      placeholder: TASK_COPY.anyTime,
      options: Object.entries(SINCE_RANGES).map(([value, range]) => ({
        value,
        label: range.label,
      })),
    },
  ]);
  const appliedFilters = $derived(
    facets.flatMap((facet) => {
      const value = filter[facet.key as keyof typeof filter];
      if (value === undefined) return [];
      const label = facet.options.find((option) => option.value === value)?.label ?? value;
      return [{ key: facet.key, value, label: `${facet.label}: ${label}` }];
    }),
  );

  function statusWordOf(state: (typeof TASK_STATE_ORDER)[number]): string {
    return taskStatusWord(state);
  }

  function clearFilters(): void {
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

  const filtered = $derived(Object.keys(filter).length > 0);

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
</script>

<section class="ib-runs ib-records" aria-label={TASK_COPY.listHeading}>
  <PageHeader title={TASK_COPY.listHeading} headingLevel={1} />

  {#snippet filterBar()}
    <FilterBar
      aria-label={TASK_COPY.filtersLabel}
      searchVisible={false}
      {facets}
      {appliedFilters}
      onFacetChange={(key, value) => change({ [key]: value })}
      onFilterRemove={(key) => change({ [key]: '' })}
      onClearAll={clearFilters}
    />
  {/snippet}
  {#snippet startRun()}
    <Button
      href={router.href(START_RUN_PATH)}
      variant="primary"
      size="sm"
      onclick={(event) => open(event, START_RUN_PATH)}>{TASK_COPY.startRun}</Button
    >
  {/snippet}
  <RecordsToolbar count={TASK_COPY.count(rows.length)} filters={filterBar} action={startRun} />

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
    <Table caption={TASK_COPY.listHeading} density="condensed">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{TASK_COPY.listColumns.agent}</Table.HeaderCell>
          <Table.HeaderCell>{TASK_COPY.listColumns.startedBy}</Table.HeaderCell>
          <Table.HeaderCell>{TASK_COPY.listColumns.status}</Table.HeaderCell>
          <Table.HeaderCell>{TASK_COPY.listColumns.when}</Table.HeaderCell>
          <Table.HeaderCell>{TASK_COPY.listColumns.took}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each rows as row (row.id)}
          {@const word = taskStatusWord(row.status)}
          <Table.Row data-run={row.id} data-status={word}>
            <Table.Cell class="ib-records__wrap">
              <a
                class="ib-run-row__agent"
                href={router.href(workflowDetailPath(row.id))}
                onclick={(event) => open(event, workflowDetailPath(row.id))}
              >
                {#if row.agentName === null}{TASK_COPY.unknownAgent}{:else}<code
                    class="ib-identifier">{agentLabel(row.agentName)}</code
                  >{/if}
              </a>
            </Table.Cell>
            <Table.Cell class="ib-run-row__what ib-records__wrap">
              <RunOrigin origin={row.origin} />
              {#if row.summary !== ''}<span class="ib-records__muted"> · {row.summary}</span>{/if}
            </Table.Cell>
            <Table.Cell><StatusLabel {word} /></Table.Cell>
            <Table.Cell>
              <span title={new Date(row.startedAt).toISOString()}
                >{formatRelativeTime(row.startedAt, Date.now())}</span
              >
            </Table.Cell>
            <Table.Cell>{row.durationMs === null ? '—' : formatDuration(row.durationMs)}</Table.Cell
            >
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
  {/if}
  <!-- Narrowing what the pages hold can leave none of them showing a run while the Bureau has more
       pages, so Load more does not wait for a row to sit beside. -->
  {#if !loading && !failed && tasks.hasNextPage}
    <div class="ib-records__more">
      <Button
        variant="secondary"
        label={TASK_COPY.loadMore}
        loading={tasks.isFetchingNextPage}
        onclick={() => void loadMoreTasks(tasks)}
      />
    </div>
  {/if}
</section>
