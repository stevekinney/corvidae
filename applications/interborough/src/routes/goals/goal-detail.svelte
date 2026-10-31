<script lang="ts">
  /**
   * `/goals/:goal`: one goal, and the attempts it has made. A goal runs an agent on a prompt until a
   * validator passes, so the page says where it stands (one of the seven status words), which agent
   * runs it, how many attempts it has used of the most it may make, and why it ended once it has.
   * Each attempt is a run: its row links to that run's page, and the row's status and times are the
   * attempt's own. The page reads itself again when `bureau.events` reports a goal event, and, while
   * that feed is not live and the goal has not ended, on a timer instead.
   *
   * A goal the caller does not own answers as a missing one does, and the view frame says so before
   * this page opens (`app/view-probes.ts`).
   */
  import {
    Button,
    EmptyState,
    ErrorState,
    PageHeader,
    Skeleton,
    Table,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { GOALS_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { useBureauEventsLive } from '../../app/live-polling.svelte.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { getGoal, goalHasEnded, type Goal } from '../../lib/bureau-goals.ts';
  import { formatDuration, formatRelativeTime } from '../../lib/format/index.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, workflowDetailPath } from '../../lib/router.svelte.ts';
  import { attemptStatusWord, goalStatusWord } from '../../lib/status.ts';
  import StatusLabel from '../../lib/status-label.svelte';

  const copy = GOALS_COPY.detail;
  const LIST_PATH = '/goals';
  /** How often the goal is read again while it has not ended and the Bureau's feed is not live. */
  const POLL_MS = 1_500;

  const goalRunId = $derived(router.current.params['goal'] ?? '');
  const bureauLive = useBureauEventsLive();
  const goal = createQuery(() => {
    // Read here, not in the interval below, which TanStack calls on its own and so is not tracked.
    const polling = !bureauLive();
    return {
      queryKey: queryKeys.goals.detail(goalRunId),
      queryFn: ({ signal }: { signal: AbortSignal }) => getGoal(goalRunId, { signal }),
      retry: false,
      // poll-reason: fallback
      refetchInterval: (query: { state: { data: Goal | undefined } }) =>
        polling && query.state.data !== undefined && !goalHasEnded(query.state.data.status)
          ? POLL_MS
          : false,
    };
  }, undefined);

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  function ago(timestamp: string): string {
    return formatRelativeTime(Date.parse(timestamp));
  }

  /** How long an attempt took: until it completed, and `—` while it has not. */
  function took(startedAt: string, completedAt: string | null): string {
    if (completedAt === null) return '—';
    return formatDuration(Date.parse(completedAt) - Date.parse(startedAt));
  }
</script>

<section class="ib-records weft-goal" aria-label={copy.title(goalRunId)} data-page="goal">
  {#if goal.isPending}
    <div role="status" aria-busy="true" aria-label={GOALS_COPY.detail.title(goalRunId)}>
      <Skeleton height="3.5rem" />
      <Skeleton height="3.5rem" />
    </div>
  {:else if goal.isError && goal.data === undefined}
    <ErrorState
      variant="flat"
      title={copy.loadFailed.title}
      description={copy.loadFailed.description}
      headingLevel={1}
      retryLabel={RETRY_LABEL}
      onRetry={() => void goal.refetch()}
    />
  {:else if goal.data !== undefined}
    {@const found = goal.data}
    {@const word = goalStatusWord(found.status)}
    {#snippet backToList()}
      <Button
        href={router.href(LIST_PATH)}
        variant="ghost"
        size="sm"
        onclick={(event) => go(event, LIST_PATH)}>{copy.backToList}</Button
      >
    {/snippet}
    <PageHeader title={copy.title(found.goalRunId)} headingLevel={1} actions={backToList} />

    <dl class="ib-facts" data-testid="goal-facts">
      <div class="ib-facts__item">
        <dt>{copy.statusFact}</dt>
        <dd><StatusLabel {word} /></dd>
      </div>
      <div class="ib-facts__item">
        <dt>{copy.agentFact}</dt>
        <dd class="ib-records__wrap">
          <a
            href={router.href(agentPath(found.agentName))}
            onclick={(event) => go(event, agentPath(found.agentName))}>{found.agentName}</a
          >
        </dd>
      </div>
      <div class="ib-facts__item">
        <dt>{copy.attemptsFact}</dt>
        <dd>{GOALS_COPY.attempts(found.usage.attempts, found.bounds.maximumAttempts)}</dd>
      </div>
      <div class="ib-facts__item">
        <dt>{copy.createdFact}</dt>
        <dd>{ago(found.createdAt)}</dd>
      </div>
      {#if found.closedAt !== null}
        <div class="ib-facts__item">
          <dt>{copy.endedFact}</dt>
          <dd>{ago(found.closedAt)}</dd>
        </div>
      {/if}
      {#if found.terminalReason !== null}
        <div class="ib-facts__item">
          <dt>{copy.reasonFact}</dt>
          <dd class="ib-records__wrap">{found.terminalReason}</dd>
        </div>
      {/if}
    </dl>

    <h2 class="ib-records__subheading">{copy.attemptsHeading}</h2>
    {#if found.attempts.length === 0}
      <EmptyState
        kind="first-use"
        title={copy.noAttempts.title}
        description={copy.noAttempts.description}
        headingLevel={3}
      />
    {:else}
      <Table caption={copy.attemptsCaption} density="condensed">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{copy.attemptColumn}</Table.HeaderCell>
            <Table.HeaderCell>{copy.runColumn}</Table.HeaderCell>
            <Table.HeaderCell>{copy.statusColumn}</Table.HeaderCell>
            <Table.HeaderCell>{copy.startedColumn}</Table.HeaderCell>
            <Table.HeaderCell>{copy.tookColumn}</Table.HeaderCell>
            <Table.HeaderCell>{copy.finishColumn}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each found.attempts.toSorted((first, second) => first.attemptIndex - second.attemptIndex) as attempt (attempt.attemptId)}
            <Table.Row data-attempt={attempt.attemptId} data-run={attempt.runId}>
              <Table.Cell>{copy.attemptLabel(attempt.attemptIndex)}</Table.Cell>
              <Table.Cell class="ib-records__wrap">
                <a
                  href={router.href(workflowDetailPath(attempt.runId))}
                  onclick={(event) => go(event, workflowDetailPath(attempt.runId))}
                  ><code class="ib-identifier">{attempt.runId}</code></a
                >
              </Table.Cell>
              <Table.Cell><StatusLabel word={attemptStatusWord(attempt.status)} /></Table.Cell>
              <Table.Cell>{ago(attempt.startedAt)}</Table.Cell>
              <Table.Cell>{took(attempt.startedAt, attempt.completedAt)}</Table.Cell>
              <Table.Cell class="ib-records__wrap">{attempt.finishReason ?? '—'}</Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table>
    {/if}
  {/if}
</section>
