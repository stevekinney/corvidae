<script lang="ts">
  /**
   * `/goals/:goal`: one goal and the attempts it has made. A goal runs an agent on a prompt until
   * its check passes, so the page says where it stands: the goal's name as the heading (and the top
   * bar's last crumb), its status word with a qualifier for what it is doing ("Running, checking the
   * result"), a note that says how it ended or what its attempt waits on, then its attempts newest
   * first (`goal-attempts.svelte`) with a Details panel beside them. Every rule for what it says is
   * in `goal-page-rows.ts`; the goal's view carries neither its prompt nor its check's feedback, so
   * the page says neither.
   *
   * The header's actions follow the goal: Edit on every goal; Stop goal, the page's main action,
   * while it works, behind a confirmation; and Start again on a goal that ended without meeting its
   * check, which opens New goal prefilled from it. Start again is off for a model agent while no
   * provider holds a key, with "Connect a provider" under it. While the server gives no answer, Edit
   * and Stop goal are inert and say why beside them; Start again only opens a page, so it stays.
   *
   * The attempt that is running is a run, and its run is read too, so an attempt parked on a review
   * says "Waiting on you" and the note links to the review in Reviews, where it is answered. The page
   * reads the goal again when `bureau.events` reports a goal event, and, while that feed is not live
   * and the goal has not ended, on a timer instead.
   *
   * The page draws its own loading and failed states under its own header (`ownsStatesOnPatterns`
   * in `app/views.ts`): while the goal is read the heading is "Goal" and the Attempts heading is
   * real, placeholders show after 300 ms, and after 10 s Cinder's "Still loading this goal…" line
   * offers Cancel. A goal the caller does not own answers as a missing one does, and the view frame
   * says so before this page opens (`app/view-probes.ts`).
   */
  import {
    Button,
    Callout,
    ConfirmDialog,
    DescriptionList,
    ErrorState,
    PageHeader,
    Skeleton,
    StaleRegion,
    StatusDot,
  } from '@lostgradient/cinder';
  import { RotateCcw, Square } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { usePageLabel } from '../../app/breadcrumbs.svelte.ts';
  import { getConnection } from '../../app/connection.svelte.ts';
  import { GOALS_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { useBureauEventsLive } from '../../app/live-polling.svelte.ts';
  import { useAgentDisplayName } from '../../lib/agent-display-name.svelte.ts';
  import { listAgents, wireCodeOf } from '../../lib/bureau-client.ts';
  import { cancelGoal, getGoal, goalHasEnded, type Goal } from '../../lib/bureau-goals.ts';
  import { getBureauReview } from '../../lib/bureau-reviews.ts';
  import { getTask, isTerminalState, type TaskView } from '../../lib/bureau-tasks.ts';
  import { viewerTimeZone } from '../../lib/format/clock.ts';
  import { getProviders } from '../../lib/host-providers.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, workflowDetailPath } from '../../lib/router.svelte.ts';
  import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
  import GoalAttempts from './goal-attempts.svelte';
  import {
    attemptRows,
    attemptWaitOf,
    goalActions,
    goalEditPath,
    goalFacts,
    goalNote,
    goalPageWord,
    liveAttempt,
    reviewPath,
    startAgainPath,
    stopDescription,
    type GoalNoteTarget,
  } from './goal-page-rows.ts';

  const copy = GOALS_COPY.detail;
  /** How often the goal is read again while it has not ended and the Bureau's feed is not live. */
  const POLL_MS = 1_500;
  /** How long a read is let to finish before its placeholders are drawn (Cinder's loading rule). */
  const LOADING_DELAY_MILLISECONDS = 300;
  /** How long a read runs before the placeholders say it is taking longer than usual. */
  const STILL_LOADING_MILLISECONDS = 10_000;

  const queryClient = useQueryClient();
  const connection = getConnection();
  const principalStore = getPrincipalStore();
  const zone = viewerTimeZone();
  const uid = $props.id();
  const offlineReasonId = `${uid}-offline`;
  const providerReasonId = `${uid}-provider`;

  const goalRunId = $derived(router.current.params['goal'] ?? '');
  const bureauLive = useBureauEventsLive();
  const agentLabel = useAgentDisplayName();
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

  // The attempt that is running is a run; its run says whether it is parked on a review.
  const live = $derived(goal.data === undefined ? undefined : liveAttempt(goal.data));
  const liveTask = createQuery(() => {
    const polling = !bureauLive();
    const runId = live?.runId ?? '';
    return {
      queryKey: queryKeys.bureauTasks.detail(runId),
      queryFn: ({ signal }: { signal: AbortSignal }) => getTask(runId, { signal }),
      enabled: runId !== '',
      retry: false,
      // poll-reason: fallback
      refetchInterval: (query: { state: { data: TaskView | undefined } }) =>
        polling && query.state.data !== undefined && !isTerminalState(query.state.data.status)
          ? POLL_MS
          : false,
    };
  }, undefined);
  // The review it is parked on names the tool and says how long it has waited.
  const openWait = $derived(
    liveTask.data?.status === 'input-required' ? liveTask.data.openWaits[0] : undefined,
  );
  const review = createQuery(() => {
    const reviewId = openWait?.reviewId ?? '';
    return {
      queryKey: queryKeys.bureauReviews.detail(reviewId),
      queryFn: ({ signal }: { signal: AbortSignal }) => getBureauReview(reviewId, { signal }),
      enabled: reviewId !== '',
      retry: false,
    };
  }, undefined);
  const liveWait = $derived(
    live === undefined ? undefined : attemptWaitOf(liveTask.data, review.data),
  );

  // Whether Start again is off: the goal's agent needs a model and no provider holds a key.
  const agents = createQuery(() => ({
    queryKey: queryKeys.agents.list(),
    queryFn: ({ signal }: { signal: AbortSignal }) => listAgents({ signal }),
    retry: false,
  }));
  const providers = createQuery(() => ({
    queryKey: queryKeys.hostProviders(),
    queryFn: ({ signal }: { signal: AbortSignal }) => getProviders({ signal }),
    retry: false,
  }));
  const needsProvider = $derived.by(() => {
    const found = goal.data;
    if (found === undefined) return false;
    // A scripted agent names no model (`media` is null), so it needs no provider.
    const summary = (agents.data ?? []).find((agent) => agent.name === found.agentName);
    return (
      summary !== undefined &&
      summary.media !== null &&
      providers.data !== undefined &&
      !providers.data.providers.some((provider) => provider.hasKey)
    );
  });

  // The clock line two counts from, read again whenever the goal or its run is.
  const now = $derived.by(() => {
    void goal.dataUpdatedAt;
    void liveTask.dataUpdatedAt;
    return Date.now();
  });

  const name = $derived.by(() => {
    const found = goal.data;
    if (found === undefined) return undefined;
    const trimmed = found.identity.name.trim();
    return trimmed === '' ? found.goalRunId : trimmed;
  });
  usePageLabel(() => ({ path: router.pathname, label: name }));

  // "Cancel" in the "Still loading" line stops the first read, and "Try again" reads again.
  // TanStack puts a first read that is cancelled back to pending, so the page keeps what it was
  // told here.
  let loadStopped = $state(false);

  function stopLoading(): void {
    loadStopped = true;
    void queryClient.cancelQueries({ queryKey: queryKeys.goals.detail(goalRunId) });
  }

  function readAgain(): void {
    loadStopped = false;
    void goal.refetch();
  }

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  /** Where a note's link goes: the attempt's run, or the review in Reviews. */
  function notePath(target: GoalNoteTarget): string {
    return target.kind === 'run' ? workflowDetailPath(target.runId) : reviewPath(target.reviewKey);
  }

  // Stop goal asks first. The dialog stays open until the Bureau answers, so a stop that fails says
  // why where it was asked, and pressing Stop goal again is the retry.
  let confirmingStop = $state(false);
  let stopping = $state(false);
  let stopFailure = $state<string | undefined>(undefined);

  async function stopGoal(found: Goal): Promise<void> {
    if (stopping) return;
    // What is stopped is read once, before the first await: the goal is read again under the dialog.
    const { goalRunId: id, revision } = found;
    stopping = true;
    stopFailure = undefined;
    try {
      const answer = await cancelGoal(id, revision);
      if (answer.outcome === 'contended') {
        stopFailure = copy.stop.changed;
      } else {
        confirmingStop = false;
      }
    } catch (error) {
      stopFailure = wireCodeOf(error) === 'StaleRevision' ? copy.stop.changed : copy.stop.failed;
    } finally {
      stopping = false;
      void queryClient.invalidateQueries({ queryKey: ['goals'] });
    }
  }

  function closeStop(): void {
    if (stopping) return;
    confirmingStop = false;
    stopFailure = undefined;
  }
</script>

<section class="ib-records ib-goal" aria-label={name ?? copy.loadingTitle} data-page="goal">
  {#if goal.data !== undefined}
    {@const found = goal.data}
    {@const word = goalPageWord(found)}
    {@const actions = goalActions(found)}
    {@const agent = agentLabel(found.agentName)}
    {@const note = goalNote(found, { zone, liveWait })}
    {@const rows = attemptRows(found, { agent, zone, now, liveWait })}
    {@const facts = goalFacts(found, {
      agent,
      zone,
      viewer: principalStore.principal?.subject,
    })}
    <!-- While the server gives no answer the shell holds every control that changes something; this
         region is how Edit and Stop goal join them, with the reason drawn beside them. -->
    {#snippet status()}<StatusDot {word} />{/snippet}
    {#snippet headerActions()}
      <div class="ib-goal__actions" data-testid="goal-actions">
        <div class="ib-goal__buttons">
          <Button
            variant="secondary"
            href={router.href(goalEditPath(found.goalRunId))}
            onclick={(event) => go(event, goalEditPath(found.goalRunId))}
            mutating>{copy.editAction}</Button
          >
          {#if actions.startAgain}
            <span class="ib-goal__start-again">
              <Button
                variant="secondary"
                href={router.href(startAgainPath(found.goalRunId))}
                aria-disabled={needsProvider ? 'true' : undefined}
                aria-describedby={needsProvider ? providerReasonId : undefined}
                onclick={(event) => go(event, startAgainPath(found.goalRunId))}
              >
                {#snippet leadingIcon()}<RotateCcw size={16} />{/snippet}
                {copy.startAgainAction}
              </Button>
              {#if needsProvider}
                <a
                  class="ib-goal__reason"
                  id={providerReasonId}
                  href={router.href(copy.connectProviderPath)}
                  onclick={(event) => go(event, copy.connectProviderPath)}
                  >{copy.connectProvider}</a
                >
              {/if}
            </span>
          {/if}
          {#if actions.stop}
            <Button variant="primary" onclick={() => (confirmingStop = true)} mutating>
              {#snippet leadingIcon()}<Square size={16} />{/snippet}
              {copy.stopAction}
            </Button>
          {/if}
        </div>
        {#if connection.unreachable}
          <p class="ib-goal__reason" id={offlineReasonId} data-testid="goal-offline-reason">
            {copy.offlineReason}
          </p>
        {/if}
      </div>
    {/snippet}
    {#snippet amberDot()}<StatusDot status="warning" size="sm" aria-hidden="true" />{/snippet}
    <StaleRegion
      stale={connection.unreachable}
      describedBy={connection.unreachable ? offlineReasonId : undefined}
    >
      <PageHeader
        title={name ?? copy.loadingTitle}
        headingLevel={1}
        {status}
        statusPlacement="inline"
        actions={headerActions}
      />

      {#if note !== undefined}
        <Callout
          variant={note.tone}
          semantic="note"
          class="ib-goal__note"
          data-testid="goal-note"
          data-tone={note.tone}
          {...note.tone === 'warning' ? { icon: amberDot } : {}}
        >
          {note.text}
          {#snippet action()}
            {#if note.link !== undefined}
              {@const path = notePath(note.link.target)}
              <a href={router.href(path)} onclick={(event) => go(event, path)}
                >{note.link.label}</a
              >
            {/if}
          {/snippet}
        </Callout>
      {/if}

      <div class="ib-goal__layout">
        <GoalAttempts
          {rows}
          made={found.usage.attempts}
          allowed={found.bounds.maximumAttempts}
          {zone}
        />
        <aside class="ib-goal__details" aria-labelledby={`${uid}-details`}>
          <h2 class="ib-goal__details-heading" id={`${uid}-details`}>{copy.detailsHeading}</h2>
          <DescriptionList items={facts} variant="facts" data-testid="goal-facts" />
        </aside>
      </div>
    </StaleRegion>

    <ConfirmDialog
      open={confirmingStop}
      title={copy.stop.title(name ?? found.goalRunId)}
      description={stopDescription(found)}
      confirmLabel={copy.stopAction}
      busyLabel={copy.stop.busy}
      destructive
      busy={stopping}
      errorTitle={stopFailure === undefined ? undefined : copy.stop.failedTitle}
      error={stopFailure}
      closeOnConfirm={false}
      onConfirm={() => void stopGoal(found)}
      onCancel={closeStop}
    >
      {#snippet confirmIcon()}<Square size={16} />{/snippet}
    </ConfirmDialog>
  {:else}
    <PageHeader title={copy.loadingTitle} headingLevel={1} error={goal.isError} />
    {#if goal.isError}
      <ErrorState
        bordered
        headingLevel={2}
        title={copy.loadFailed.title}
        description={copy.loadFailed.description}
        retryLabel={RETRY_LABEL}
        onRetry={() => void goal.refetch()}
      />
    {:else if loadStopped}
      <ErrorState
        bordered
        headingLevel={2}
        tone="neutral"
        title={copy.stopped.title}
        description={copy.stopped.description}
        retryLabel={RETRY_LABEL}
        retryVariant="secondary"
        onRetry={readAgain}
      />
    {:else}
      <div class="ib-goal__layout">
        <section class="ib-goal-loading" aria-labelledby={`${uid}-loading-attempts`}>
          <h2 class="ib-goal__attempts-heading" id={`${uid}-loading-attempts`}>
            {copy.attemptsHeading}
          </h2>
          <Skeleton
            variant="list"
            rows={3}
            statusMarker="dot"
            label={copy.loading}
            delay={LOADING_DELAY_MILLISECONDS}
            stillLoadingAfter={STILL_LOADING_MILLISECONDS}
            stillLoadingLabel={copy.stillLoading}
            onCancel={stopLoading}
          />
        </section>
      </div>
    {/if}
  {/if}
</section>

<style>
  .ib-goal__actions {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--cinder-space-1);
  }

  .ib-goal__buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: flex-end;
    gap: var(--cinder-space-2);
  }

  .ib-goal__start-again {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--cinder-space-1);
  }

  .ib-goal__reason {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  .ib-goal :global(.ib-goal__note) {
    margin-block-end: var(--cinder-space-4);
  }

  /* The attempts take the room; the Details panel sits beside them, and under them on a phone. */
  .ib-goal__layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(14rem, 18rem);
    align-items: start;
    gap: var(--cinder-space-6);
  }

  @media (max-width: 47.99rem) {
    .ib-goal__layout {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .ib-goal__details {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }

  .ib-goal__details-heading,
  .ib-goal__attempts-heading {
    margin: 0;
    font-size: var(--cinder-text-base);
    font-weight: var(--cinder-font-semibold);
  }

  .ib-goal-loading {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }
</style>
