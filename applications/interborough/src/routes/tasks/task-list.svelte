<script lang="ts">
  /**
   * `/tasks`: the caller's tasks, newest first, a page at a time (`bureau.tasks.list`). The filters
   * are the address's (`?agent=`, `?status=`, `?session=`), so a link from a chat session lands on
   * its tasks and a filtered list can be shared. Each task links to its page and to its session.
   * The view frame has settled that the caller has a task at all, so an empty list here is a
   * filter that matches none.
   */
  import { untrack } from 'svelte';

  import { Badge, Button, EmptyState, ErrorState, Input, Select, Skeleton, Table } from '@lostgradient/cinder';
  import { createInfiniteQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, TASK_COPY } from '../../app/copy.ts';
  import { listTasks } from '../../lib/bureau-tasks.ts';
  import { formatRelativeTime, truncateId } from '../../lib/format/index.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { hasTaskFilter, parseTaskFilter, serializeTaskFilter } from './task-filter.ts';
  import { TASK_STATE_ORDER, taskStatePresentation } from './task-presentation.ts';

  const PAGE_SIZE = 50;

  const filter = $derived(parseTaskFilter(router.current.search));

  const tasks = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.bureauTasks.list(filter),
      queryFn: ({ pageParam, signal }) =>
        listTasks({ ...filter, limit: PAGE_SIZE, offset: pageParam }, { signal }),
      initialPageParam: 0,
      getNextPageParam: (last) => last.nextOffset ?? undefined,
      retry: false,
    }),
    undefined,
  );

  const rows = $derived((tasks.data?.pages ?? []).flatMap((page) => page.tasks));

  // The form edits a draft, and the address changes only when it is submitted. A change of the
  // address from elsewhere, such as Back, replaces the draft.
  let agent = $state(untrack(() => filter.agentName ?? ''));
  let status = $state(untrack(() => filter.status ?? ''));
  let session = $state(untrack(() => filter.contextId ?? ''));
  $effect(() => {
    agent = filter.agentName ?? '';
    status = filter.status ?? '';
    session = filter.contextId ?? '';
  });

  const statusOptions = [
    { value: '', label: TASK_COPY.anyStatus },
    ...TASK_STATE_ORDER.map((state) => ({ value: state, label: TASK_COPY.states[state] })),
  ];

  function applyFilter(event: SubmitEvent): void {
    event.preventDefault();
    const query = serializeTaskFilter({ agent, status, session });
    router.navigate(`/tasks${query === '' ? '' : `?${query}`}`, { replace: true });
  }

  function clearFilter(): void {
    router.navigate('/tasks', { replace: true });
  }

  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="weft-tasks" aria-labelledby="weft-tasks-title">
  <header class="weft-tasks__header">
    <h1 id="weft-tasks-title" class="weft-tasks__title">{TASK_COPY.listHeading}</h1>
  </header>

  <form class="weft-tasks__filters" aria-label={TASK_COPY.filtersLabel} onsubmit={applyFilter}>
    <Input
      id="weft-tasks-filter-agent"
      name="agent"
      label={TASK_COPY.agentLabel}
      bind:value={agent}
    />
    <Select
      id="weft-tasks-filter-status"
      name="status"
      label={TASK_COPY.statusLabel}
      bind:value={status}
      options={statusOptions}
    />
    <Input
      id="weft-tasks-filter-session"
      name="session"
      label={TASK_COPY.sessionLabel}
      bind:value={session}
    />
    <div class="weft-tasks__filter-actions">
      <Button type="submit" variant="primary" label={TASK_COPY.filterAction} />
      {#if hasTaskFilter(filter)}
        <Button type="button" variant="ghost" label={TASK_COPY.clearAction} onclick={clearFilter} />
      {/if}
    </div>
  </form>

  {#if tasks.isPending}
    <div role="status" aria-busy="true" aria-label="Loading tasks">
      <Skeleton height="2.5rem" />
      <Skeleton height="2.5rem" />
    </div>
  {:else if tasks.isError}
    <ErrorState
      title="The tasks could not be loaded"
      description="The Bureau did not answer. Check that the host is running, then try again."
      headingLevel={2}
      retryLabel={RETRY_LABEL}
      onRetry={() => void tasks.refetch()}
    />
  {:else if rows.length === 0}
    <EmptyState
      title={TASK_COPY.noMatch.title}
      description={TASK_COPY.noMatch.description}
      headingLevel={2}
    />
  {:else}
    <Table caption={TASK_COPY.listHeading} scrollable class="weft-tasks__table">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{TASK_COPY.columns.status}</Table.HeaderCell>
          <Table.HeaderCell>{TASK_COPY.columns.agent}</Table.HeaderCell>
          <Table.HeaderCell>{TASK_COPY.columns.task}</Table.HeaderCell>
          <Table.HeaderCell>{TASK_COPY.columns.session}</Table.HeaderCell>
          <Table.HeaderCell align="right">{TASK_COPY.columns.updated}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each rows as task (task.id)}
          {@const presentation = taskStatePresentation(task.status)}
          <Table.Row>
            <Table.Cell>
              <Badge variant={presentation.variant}>{presentation.label}</Badge>
              {#if task.openWaits.length > 0}
                <span class="weft-tasks__waits">{TASK_COPY.openWaits(task.openWaits.length)}</span>
              {/if}
            </Table.Cell>
            <Table.Cell>{task.agentName ?? ''}</Table.Cell>
            <Table.Cell as="th">
              <a
                class="weft-tasks__link"
                href={router.href(`/tasks/${encodeURIComponent(task.id)}`)}
                onclick={(event) => open(event, `/tasks/${encodeURIComponent(task.id)}`)}
                ><code title={task.id}>{truncateId(task.id)}</code></a
              >
            </Table.Cell>
            <Table.Cell>
              <a
                class="weft-tasks__link"
                href={router.href(`/chat/${encodeURIComponent(task.contextId)}`)}
                onclick={(event) => open(event, `/chat/${encodeURIComponent(task.contextId)}`)}
                ><code title={task.contextId}>{truncateId(task.contextId)}</code></a
              >
            </Table.Cell>
            <Table.Cell align="right">
              <span title={task.updatedAt}>{formatRelativeTime(Date.parse(task.updatedAt), Date.now())}</span>
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
    {#if tasks.hasNextPage}
      <div class="weft-tasks__more">
        <Button
          variant="secondary"
          label={TASK_COPY.loadMore}
          loading={tasks.isFetchingNextPage}
          onclick={() => void tasks.fetchNextPage()}
        />
      </div>
    {/if}
  {/if}
</section>
