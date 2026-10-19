<script lang="ts">
  /**
   * `/goals`: the caller's goals, oldest first, ended ones included. A goal runs an agent on a prompt
   * until a validator passes, so a row says where it stands (the status as the Bureau names it), the
   * agent, and how many attempts it has used of the most it may make. New goal opens the drawer
   * (`?create=1`), and a goal that has not ended can be cancelled, after a confirmation, with the
   * revision of the goal the page read: a goal that moved since is refused, and the page says it
   * changed and reads it again. While a goal is running the list reads itself again, so a goal ends on
   * screen as the Bureau ends it.
   *
   * Owner scoping is the gate, so the view holds no scope. Whether there is nothing to list, or the
   * Bureau is failing or refusing, is the view frame's to say (`app/view-probes.ts`).
   */
  import { Alert, Badge, Button, ConfirmDialog, Table } from '@lostgradient/cinder';
  import {
    createInfiniteQuery,
    createMutation,
    useQueryClient,
    type InfiniteData,
  } from '@tanstack/svelte-query';

  import { GOALS_COPY, STALE_COPY, VIEW_COPY } from '../../app/copy.ts';
  import { showFault } from '../../app/toast-host.svelte';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import {
    cancelGoal,
    goalHasEnded,
    listGoals,
    type Goal,
    type GoalPage,
  } from '../../lib/bureau-goals.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import GoalFormDrawer from './goal-form-drawer.svelte';

  const PAGE_SIZE = 50;
  /** How often the list reads itself again while a goal has not ended. */
  const POLL_MS = 1_500;

  const queryClient = useQueryClient();

  const goals = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.goals.list(),
      queryFn: ({ pageParam, signal }) =>
        listGoals({ limit: PAGE_SIZE, offset: pageParam }, { signal }),
      initialPageParam: 0,
      getNextPageParam: (last: GoalPage) => last.nextOffset ?? undefined,
      retry: false,
      refetchInterval: (query: { state: { data: InfiniteData<GoalPage> | undefined } }) =>
        (query.state.data?.pages ?? []).some((page) =>
          page.goals.some((goal) => !goalHasEnded(goal.status)),
        )
          ? POLL_MS
          : false,
    }),
    undefined,
  );
  const rows = $derived((goals.data?.pages ?? []).flatMap((page) => page.goals));

  const isCreate = $derived(router.current.search.get('create') === '1');

  function openCreate(): void {
    router.navigate('/goals?create=1');
  }

  function closeCreate(): void {
    router.navigate('/goals');
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

  function agentPath(name: string): string {
    return `/agents/${encodeURIComponent(name)}`;
  }

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

<section class="weft-goals" aria-labelledby="weft-goals-title" data-page="goals">
  <header class="weft-goals__header">
    <h1 id="weft-goals-title" class="weft-goals__title">{VIEW_COPY.goals.label}</h1>
    <Button variant="primary" size="sm" onclick={openCreate}>{GOALS_COPY.newAction}</Button>
  </header>

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
      <Button variant="secondary" size="sm" onclick={() => void goals.refetch()}>Try again</Button>
    </Alert>
  {:else if rows.length > 0}
    <Table scrollable caption={GOALS_COPY.caption}>
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
        {#each keyedByOccurrence(rows, (goal) => goal.goalRunId) as { key, item: goal } (key)}
          <Table.Row data-goal={goal.goalRunId} data-status={goal.status}>
            <Table.Cell class="weft-goals__mono">{goal.goalRunId}</Table.Cell>
            <Table.Cell>
              <a
                href={router.href(agentPath(goal.agentName))}
                onclick={(event) => go(event, agentPath(goal.agentName))}>{goal.agentName}</a
              >
            </Table.Cell>
            <Table.Cell>
              <Badge
                variant={goal.status === 'succeeded'
                  ? 'success'
                  : goal.status === 'failed'
                    ? 'danger'
                    : 'neutral'}>{goal.status}</Badge
              >
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
    {#if goals.hasNextPage}
      <div class="weft-goals__more">
        <Button
          variant="secondary"
          size="sm"
          disabled={goals.isFetchingNextPage}
          onclick={() => void goals.fetchNextPage()}>{GOALS_COPY.loadMore}</Button
        >
      </div>
    {/if}
  {/if}
</section>

{#if isCreate}
  <GoalFormDrawer onClose={closeCreate} />
{/if}

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

  .weft-goals__header {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: center;
    justify-content: space-between;
  }

  .weft-goals__title {
    margin: 0;
    font-size: var(--cinder-text-xl);
    font-weight: 600;
  }

  .weft-goals__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-goals__alert-body {
    margin: 4px 0 8px;
  }

  .weft-goals__more {
    display: flex;
    justify-content: center;
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
