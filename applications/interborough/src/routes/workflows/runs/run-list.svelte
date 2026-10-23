<script lang="ts">
  /**
   * `/runs`: what the agents have done, newest first, in the words of a task (`run-rows.ts`). Each
   * row says which agent ran, what started it, how it stands, when, and how long it took. The title
   * and the filters are one bar, and the filters (status, agent, what started it, how recently) are
   * the address's, so a filtered list can be shared. The engine's own table of workflows is the
   * Engine area's; it is not here.
   */
  import { Badge, Button, EmptyState, ErrorState, Select, Skeleton } from '@lostgradient/cinder';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, TASK_COPY } from '../../../app/copy.ts';
  import { listAgents, listAllContexts } from '../../../lib/bureau-client.ts';
  import { listAllGoals } from '../../../lib/bureau-goals.ts';
  import { listTasks, loadMoreTasks } from '../../../lib/bureau-tasks.ts';
  import { combinePages } from '../../../lib/combine-pages.ts';
  import { formatDuration, formatRelativeTime } from '../../../lib/format/index.ts';
  import { router, workflowDetailPath } from '../../../lib/router.svelte.ts';
  import { taskStatePresentation, TASK_STATE_ORDER } from '../../../lib/task-status.ts';
  import { REVIEW_POLL_MILLISECONDS } from '../../reviews/reviews-data.ts';
  import {
    buildRunRows,
    filterRunRows,
    parseRunFilter,
    serializeRunFilter,
    SINCE_RANGES,
    STARTED_BY_LABELS,
  } from './run-rows.ts';

  const PAGE_SIZE = 100;
  const filter = $derived(parseRunFilter(router.current.search));

  // The status and the agent are asked of the Bureau, so a page holds the runs that match and Load
  // more goes on from there. "Working" is two of the Bureau's states (a submitted task is working
  // too), so it is narrowed here instead. The rest (what started a run, how recently) the Bureau
  // cannot narrow, and are applied to what the pages hold.
  const serverStatus = $derived(filter.status === 'working' ? undefined : filter.status);
  const tasks = createInfiniteQuery(
    () => ({
      queryKey: ['bureau-tasks', 'runs', serverStatus ?? '', filter.agent ?? ''] as const,
      queryFn: ({ pageParam, signal }) =>
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
      getNextPageParam: (last) => last.nextPageToken ?? undefined,
      refetchInterval: REVIEW_POLL_MILLISECONDS,
      retry: false,
    }),
    undefined,
  );
  // Every goal, a page at a time: a run past the first hundred is still a run.
  const goals = createQuery(
    () => ({
      queryKey: ['goals', 'runs'] as const,
      queryFn: ({ signal }) => listAllGoals({ signal }),
      refetchInterval: REVIEW_POLL_MILLISECONDS,
      retry: false,
    }),
    undefined,
  );
  // The agents to filter by come from the catalog, because the runs on screen are already narrowed
  // to the agent chosen and would leave nothing else to choose.
  const agents = createQuery(
    () => ({
      queryKey: ['agents', 'runs'] as const,
      queryFn: () => listAgents(),
      retry: false,
    }),
    undefined,
  );
  const chats = createQuery(
    () => ({
      queryKey: ['contexts', 'runs'] as const,
      queryFn: ({ signal }) => listAllContexts({ signal }),
      refetchInterval: REVIEW_POLL_MILLISECONDS,
      retry: false,
    }),
    undefined,
  );

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

  const statusOptions = [
    { value: '', label: TASK_COPY.anyStatus },
    ...TASK_STATE_ORDER.map((state) => ({ value: state, label: TASK_COPY.states[state] })),
  ];
  const agentOptions = $derived([
    { value: '', label: TASK_COPY.anyAgent },
    ...agentNames.map((name) => ({ value: name, label: name })),
  ]);
  const startedByOptions = [
    { value: '', label: TASK_COPY.anyOrigin },
    ...Object.entries(STARTED_BY_LABELS).map(([value, label]) => ({ value, label })),
  ];
  const sinceOptions = [
    { value: '', label: TASK_COPY.anyTime },
    ...Object.entries(SINCE_RANGES).map(([value, range]) => ({ value, label: range.label })),
  ];

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

<section class="ib-runs" aria-labelledby="ib-runs-title">
  <header class="ib-runs__bar">
    <h1 id="ib-runs-title" class="ib-runs__title">{TASK_COPY.listHeading}</h1>
    <form
      class="ib-runs__filters"
      aria-label={TASK_COPY.filtersLabel}
      onsubmit={(event) => event.preventDefault()}
    >
      <Select
        id="ib-runs-status"
        label={TASK_COPY.statusLabel}
        labelVisible={false}
        options={statusOptions}
        value={filter.status ?? ''}
        onchange={(event) => change({ status: event.currentTarget.value })}
      />
      <Select
        id="ib-runs-agent"
        label={TASK_COPY.agentLabel}
        labelVisible={false}
        options={agentOptions}
        value={filter.agent ?? ''}
        onchange={(event) => change({ agent: event.currentTarget.value })}
      />
      <Select
        id="ib-runs-started-by"
        label={TASK_COPY.startedByLabel}
        labelVisible={false}
        options={startedByOptions}
        value={filter.startedBy ?? ''}
        onchange={(event) => change({ startedBy: event.currentTarget.value })}
      />
      <Select
        id="ib-runs-since"
        label={TASK_COPY.sinceLabel}
        labelVisible={false}
        options={sinceOptions}
        value={filter.since ?? ''}
        onchange={(event) => change({ since: event.currentTarget.value })}
      />
    </form>
  </header>

  {#if loading}
    <div role="status" aria-busy="true" aria-label={TASK_COPY.loading}>
      <Skeleton height="3.5rem" />
      <Skeleton height="3.5rem" />
    </div>
  {:else if failed}
    <ErrorState
      title={TASK_COPY.loadFailed.title}
      description={TASK_COPY.loadFailed.description}
      headingLevel={2}
      retryLabel={RETRY_LABEL}
      onRetry={retry}
    />
  {:else if rows.length === 0}
    <EmptyState
      title={filtered ? TASK_COPY.noMatch.title : TASK_COPY.empty.title}
      description={filtered ? TASK_COPY.noMatch.description : TASK_COPY.empty.description}
      headingLevel={2}
    />
  {:else}
    <ul class="ib-runs__list" aria-label={TASK_COPY.listHeading}>
      {#each rows as row (row.id)}
        {@const presentation = taskStatePresentation(row.status)}
        <li class="ib-run-row" data-run={row.id} data-status={presentation.label}>
          <a
            class="ib-run-row__agent"
            href={router.href(workflowDetailPath(row.id))}
            onclick={(event) => open(event, workflowDetailPath(row.id))}
          >
            {#if row.agentName === null}{TASK_COPY.unknownAgent}{:else}<code class="ib-identifier"
                >{row.agentName}</code
              >{/if}
          </a>
          <span class="ib-run-row__what">
            {#if row.origin.kind === 'chat'}
              <a
                href={router.href(row.origin.href)}
                onclick={(event) => open(event, row.origin.kind === 'chat' ? row.origin.href : '')}
                >{row.origin.title === '' ? TASK_COPY.untitledChat : row.origin.title}</a
              >
            {:else if row.origin.kind === 'schedule'}
              <a
                href={router.href(row.origin.href)}
                onclick={(event) =>
                  open(event, row.origin.kind === 'schedule' ? row.origin.href : '')}
                >{row.origin.title === '' ? TASK_COPY.untitledChat : row.origin.title}</a
              >
              ({TASK_COPY.schedule})
            {:else if row.origin.kind === 'goal'}
              <a
                href={router.href(row.origin.href)}
                onclick={(event) => open(event, row.origin.kind === 'goal' ? row.origin.href : '')}
                ><code class="ib-identifier">{row.origin.name}</code> ({TASK_COPY.goal})</a
              >
              {#if row.origin.session}
                {@const session = row.origin.session}
                ·
                <a
                  href={router.href(session.href)}
                  onclick={(event) => open(event, session.href)}
                  >{session.title === '' ? TASK_COPY.untitledChat : session.title}</a
                >
              {/if}
            {:else}
              {TASK_COPY.startedDirectly}
            {/if}
            {#if row.summary !== ''}<span class="ib-runs__summary"> · {row.summary}</span>{/if}
          </span>
          <Badge variant={presentation.variant}>{presentation.label}</Badge>
          <span class="ib-run-row__when">
            <span title={new Date(row.startedAt).toISOString()}
              >{formatRelativeTime(row.startedAt, Date.now())}</span
            >
            · {row.durationMs === null ? '—' : formatDuration(row.durationMs)}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
  <!-- Narrowing what the pages hold can leave none of them showing a run while the Bureau has more
       pages, so Load more does not wait for a row to sit beside. -->
  {#if !loading && !failed && tasks.hasNextPage}
    <div class="ib-runs__more">
      <Button
        variant="secondary"
        label={TASK_COPY.loadMore}
        loading={tasks.isFetchingNextPage}
        onclick={() => void loadMoreTasks(tasks)}
      />
    </div>
  {/if}
</section>
