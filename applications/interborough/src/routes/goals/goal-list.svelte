<script lang="ts">
  /**
   * `/goals`: the caller's goals, oldest first, ended ones included, as a table. A goal runs an
   * agent on a prompt until a validator passes, so a row says where it stands (one of the seven
   * status words, `lib/status.ts`), the agent, and how many attempts it has used of the most it may
   * make; its identifier opens the goal's page, which lists the attempts. The toolbar under the
   * heading has the count, the filters (status, agent) and New goal, which opens `/goals/new`. A goal
   * that has not ended can be cancelled, after a confirmation, with the
   * revision of the goal the page read: a goal that moved since is refused, and the page says it
   * changed and reads it again. The list reads itself again when `bureau.events` reports a goal
   * event, so a goal ends on screen as the Bureau ends it; while that feed is not live and a goal has
   * not ended, it reads itself again on a timer instead.
   *
   * Owner scoping is the gate, so the view holds no scope. Whether there is nothing to list, or the
   * Bureau is failing or refusing, is the view frame's to say (`app/view-probes.ts`).
   */
  import {
    Alert,
    Button,
    ConfirmDialog,
    EmptyState,
    FilterBar,
    PageHeader,
    Table,
  } from '@lostgradient/cinder';
  import {
    createInfiniteQuery,
    createMutation,
    useQueryClient,
    type InfiniteData,
  } from '@tanstack/svelte-query';

  import { GOALS_COPY, RETRY_LABEL, STALE_COPY, VIEW_COPY } from '../../app/copy.ts';
  import RecordsToolbar from '../../app/records/records-toolbar.svelte';
  import { useBureauEventsLive } from '../../app/live-polling.svelte.ts';
  import { showFault } from '../../app/toast-host.svelte';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import { useAgentDisplayName } from '../../lib/agent-display-name.svelte.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import {
    cancelGoal,
    goalHasEnded,
    listGoals,
    type Goal,
    type GoalPage,
  } from '../../lib/bureau-goals.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { goalPath } from '../../lib/identifier-paths.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { goalStatusWord, STATUS_WORDS } from '../../lib/status.ts';
  import StatusLabel from '../../lib/status-label.svelte';

  const PAGE_SIZE = 50;
  /** The page that makes a goal. */
  const NEW_GOAL_PATH = '/goals/new';
  /** How often the list reads itself again while a goal has not ended and the Bureau's feed is not live. */
  const POLL_MS = 1_500;

  const queryClient = useQueryClient();

  const bureauLive = useBureauEventsLive();
  const goals = createInfiniteQuery(() => {
    // Read here, not in the interval below, which TanStack calls on its own and so is not tracked.
    const polling = !bureauLive();
    return {
      queryKey: queryKeys.goals.list(),
      queryFn: ({ pageParam, signal }: { pageParam: number; signal: AbortSignal }) =>
        listGoals({ limit: PAGE_SIZE, offset: pageParam }, { signal }),
      initialPageParam: 0,
      getNextPageParam: (last: GoalPage) => last.nextOffset ?? undefined,
      retry: false,
      // poll-reason: fallback
      refetchInterval: (query: { state: { data: InfiniteData<GoalPage> | undefined } }) =>
        polling &&
        (query.state.data?.pages ?? []).some((page) =>
          page.goals.some((goal) => !goalHasEnded(goal.status)),
        )
          ? POLL_MS
          : false,
    };
  }, undefined);
  const rows = $derived((goals.data?.pages ?? []).flatMap((page) => page.goals));

  const statusFilter = $derived(
    STATUS_WORDS.find((word) => word === router.current.search.get('status')),
  );
  const agentFilter = $derived(router.current.search.get('agent') ?? undefined);

  // The Bureau lists goals by offset and cannot narrow them, so the filters narrow the pages held.
  const visible = $derived(
    rows.filter(
      (goal) =>
        (statusFilter === undefined || goalStatusWord(goal.status) === statusFilter) &&
        (agentFilter === undefined || goal.agentName === agentFilter),
    ),
  );
  const agentLabel = useAgentDisplayName();
  const agentNames = $derived(
    [
      ...new Set([...rows.map((goal) => goal.agentName), ...(agentFilter ? [agentFilter] : [])]),
    ].toSorted(),
  );
  const facets = $derived([
    {
      type: 'select' as const,
      key: 'status',
      label: GOALS_COPY.statusColumn,
      placeholder: GOALS_COPY.anyStatus,
      options: STATUS_WORDS.map((word) => ({ value: word, label: word })),
    },
    {
      type: 'select' as const,
      key: 'agent',
      label: GOALS_COPY.agentColumn,
      placeholder: GOALS_COPY.anyAgent,
      options: agentNames.map((name) => ({ value: name, label: agentLabel(name) })),
    },
  ]);
  const appliedFilters = $derived([
    ...(statusFilter === undefined
      ? []
      : [
          {
            key: 'status',
            value: statusFilter,
            label: GOALS_COPY.statusColumn,
          },
        ]),
    ...(agentFilter === undefined
      ? []
      : [{ key: 'agent', value: agentFilter, label: GOALS_COPY.agentColumn }]),
  ]);

  function changeFilter(key: string, value: string): void {
    const params = new URLSearchParams(router.current.search);
    if (value === '') params.delete(key);
    else params.set(key, value);
    const query = params.toString();
    router.navigate(`/goals${query === '' ? '' : `?${query}`}`, { replace: true });
  }

  function clearFilters(): void {
    router.navigate('/goals', { replace: true });
  }

  /** A cancel the Bureau refused for being stale: nothing was changed, and the list was read again. */
  let staleGoal = $state<string | null>(null);
  /** A cancel the Bureau recorded and has not finished. */
  let pending = $state(false);

  let confirming = $state(false);
  let target = $state<Goal | null>(null);

  function askToCancel(goal: Goal): void {
    target = goal;
    confirming = true;
  }

  const cancellation = createMutation(() => ({
    mutationFn: (goal: Goal) => cancelGoal(goal.goalRunId, goal.revision),
    onMutate: () => {
      staleGoal = null;
      pending = false;
    },
    onSuccess: (answer) => {
      pending = answer.outcome === 'cancellation-pending';
      void queryClient.invalidateQueries({ queryKey: queryKeys.goals.list() });
    },
    onError: (error: unknown, goal: Goal) => {
      if (agentFaultOf(error).kind === 'stale') {
        staleGoal = goal.goalRunId;
        void queryClient.invalidateQueries({ queryKey: queryKeys.goals.list() });
        return;
      }
      const treatment = faultTreatment(error);
      showFault({ ...treatment, message: `${GOALS_COPY.cancelFailed}. ${treatment.message}` });
    },
  }));

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  function createdAgo(goal: Goal): string {
    return formatRelativeTime(Date.parse(goal.createdAt));
  }
</script>

<section class="weft-goals ib-records" aria-label={VIEW_COPY.goals.label} data-page="goals">
  <PageHeader title={VIEW_COPY.goals.label} headingLevel={1} />

  {#snippet filterBar()}
    <FilterBar
      aria-label={GOALS_COPY.filtersLabel}
      searchVisible={false}
      {facets}
      {appliedFilters}
      onFacetChange={changeFilter}
      onFilterRemove={(key) => changeFilter(key, '')}
      onClearAll={clearFilters}
    />
  {/snippet}
  {#snippet newGoal()}
    <Button
      href={router.href(NEW_GOAL_PATH)}
      variant="primary"
      size="sm"
      onclick={(event) => go(event, NEW_GOAL_PATH)}>{GOALS_COPY.newAction}</Button
    >
  {/snippet}
  <RecordsToolbar count={GOALS_COPY.count(visible.length)} filters={filterBar} action={newGoal} />

  {#if staleGoal !== null}
    <Alert
      variant="warning"
      dismissible
      onDismiss={() => (staleGoal = null)}
      data-testid="goal-notice"
    >
      <p class="weft-goals__alert-title">{STALE_COPY.title(staleGoal)}</p>
      <p class="weft-goals__alert-body">{STALE_COPY.description}</p>
    </Alert>
  {/if}
  {#if pending}
    <Alert variant="info" dismissible onDismiss={() => (pending = false)}>
      <p class="weft-goals__alert-body">{GOALS_COPY.cancelPending}</p>
    </Alert>
  {/if}

  {#if goals.isError}
    <Alert variant="danger">
      <p class="weft-goals__alert-title">{VIEW_COPY.goals.error.title}</p>
      <p class="weft-goals__alert-body">{VIEW_COPY.goals.error.description}</p>
      <Button variant="secondary" size="sm" onclick={() => void goals.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if rows.length > 0 && visible.length === 0}
    <EmptyState
      kind="filtered"
      title={GOALS_COPY.noMatch.title}
      description={GOALS_COPY.noMatch.description}
      headingLevel={2}
      clearFiltersLabel={GOALS_COPY.clearAction}
      onClearFilters={clearFilters}
    />
  {:else if rows.length > 0}
    <Table caption={GOALS_COPY.caption} density="condensed">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{GOALS_COPY.goalColumn}</Table.HeaderCell>
          <Table.HeaderCell>{GOALS_COPY.agentColumn}</Table.HeaderCell>
          <Table.HeaderCell>{GOALS_COPY.statusColumn}</Table.HeaderCell>
          <Table.HeaderCell>{GOALS_COPY.attemptsColumn}</Table.HeaderCell>
          <Table.HeaderCell>{GOALS_COPY.createdColumn}</Table.HeaderCell>
          <Table.HeaderCell
            ><span class="weft-sr-only">{GOALS_COPY.actionsColumn}</span></Table.HeaderCell
          >
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each keyedByOccurrence(visible, (goal) => goal.goalRunId) as { key, item: goal } (key)}
          {@const word = goalStatusWord(goal.status)}
          <Table.Row data-goal={goal.goalRunId} data-status={goal.status} data-status-word={word}>
            <Table.Cell class="weft-goals__mono">
              <a
                href={router.href(goalPath(goal.goalRunId))}
                onclick={(event) => go(event, goalPath(goal.goalRunId))}>{goal.goalRunId}</a
              >
            </Table.Cell>
            <Table.Cell class="ib-records__wrap">
              <a
                href={router.href(agentPath(goal.agentName))}
                onclick={(event) => go(event, agentPath(goal.agentName))}
                >{agentLabel(goal.agentName)}</a
              >
            </Table.Cell>
            <Table.Cell>
              <StatusLabel {word} />
              {#if goal.cancellation !== null && !goalHasEnded(goal.status)}
                <span class="weft-goals__muted">{GOALS_COPY.cancelRequested}</span>
              {/if}
            </Table.Cell>
            <Table.Cell
              >{GOALS_COPY.attempts(goal.usage.attempts, goal.bounds.maximumAttempts)}</Table.Cell
            >
            <Table.Cell class="weft-goals__muted">{createdAgo(goal)}</Table.Cell>
            <Table.Cell align="right">
              {#if !goalHasEnded(goal.status)}
                <Button
                  data-changes
                  variant="ghost"
                  size="sm"
                  disabled={cancellation.isPending}
                  onclick={() => askToCancel(goal)}>{GOALS_COPY.cancelAction}</Button
                >
              {/if}
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
  {/if}
  {#if !goals.isError && goals.hasNextPage}
    <div class="ib-records__more">
      <Button
        variant="secondary"
        size="sm"
        disabled={goals.isFetchingNextPage}
        onclick={() => void goals.fetchNextPage()}>{GOALS_COPY.loadMore}</Button
      >
    </div>
  {/if}
</section>

<ConfirmDialog
  bind:open={confirming}
  title={GOALS_COPY.cancelDialog.title}
  description={target === null ? '' : GOALS_COPY.cancelDialog.description(target.goalRunId)}
  confirmLabel={GOALS_COPY.cancelDialog.confirm}
  destructive
  onConfirm={() => {
    if (target !== null) cancellation.mutate(target);
  }}
/>

<style>
  .weft-goals {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .weft-goals__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-goals__alert-body {
    margin: 4px 0 8px;
  }

  .weft-goals__muted {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
  }

  :global(.weft-goals__mono) {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .weft-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
