<script lang="ts">
  /**
   * The reviews inbox: everything waiting on a person, in one two-panel view. The list holds the
   * Bureau's pending reviews (tool approvals and questions of the agents' runs) and, when the
   * principal may read them, the engine's human reviews, longest-waiting first, with one count. The
   * detail pane shows the selected review with the decision form its kind needs: the Bureau's own
   * (`bureau-review-form.svelte`, an approval or denial, or a rejection with its reason) or the
   * engine's (`review-decision-form.svelte`). `index.svelte` owns the queries, the mutations, and
   * the scope that decides whether the engine is read; this component owns the tri-state filter,
   * selection, the live toggle, and layout. The Decided and Timed out states are the engine's: the
   * Bureau lists no resolved review, so it has no Archive to offer either.
   *
   * The live toggle defaults off. Turning it on subscribes to the shell's ONE shared
   * `FleetEventSource` from context (`getFleetEventSource()`, provided in
   * `src/app/shell/shell.svelte`); toggle-off/unmount only unsubscribes, never `close()`, because
   * the source is shared with the notification center and every other live surface.
   */
  import {
    ConnectionIndicator,
    EmptyState,
    ResizablePanels,
    Segment,
    SegmentedControl,
    Skeleton,
    Toggle,
    Tooltip,
  } from '@lostgradient/cinder';
  import type { ReviewListEntry } from '@lostgradient/weft';
  import { MediaQuery } from 'svelte/reactivity';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import type { BureauHumanWait, BureauReview, ReviewDecision } from '../../lib/bureau-reviews.ts';

  import { useQueryClient } from '@tanstack/svelte-query';

  import { getFleetEventSource } from '../../app/engine-status.svelte.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import { invalidateReviewQueries } from '../../lib/review-queries.ts';
  import BureauReviewDetail, { type ReviewOutcome } from './bureau-review-detail.svelte';
  import BureauReviewRow from './bureau-review-row.svelte';
  import CompletedReviewRow from './completed-review-row.svelte';
  import PendingReviewRow from './pending-review-row.svelte';
  import QueryFaultBanner from './query-fault-banner.svelte';
  import type { ReviewDecisionSubmission } from './review-decision-form.svelte';
  import ReviewDetailPanel from './review-detail-panel.svelte';
  import {
    completedEntriesOnly,
    isReviewFleetEventKind,
    partitionPendingReviews,
    pendingEntriesOnly,
    type ReviewQuery,
    type ReviewInboxState,
  } from './review-domain.ts';
  import { mergePendingReviews, weftReviewItem, type ReviewItem } from './review-items.ts';

  interface ReviewsInboxProps {
    /** The Bureau's pending reviews. */
    readonly bureauQuery: ReviewQuery<readonly BureauReview[]>;
    /** The engine's pending reviews. Read only while `weftEnabled`. */
    readonly pendingQuery: ReviewQuery<ReviewListEntry[]>;
    /** The engine's decided reviews. Read only while `weftEnabled`. */
    readonly completedQuery: ReviewQuery<ReviewListEntry[]>;
    /** Whether the engine's reviews are read at all: only for a principal that holds `reviews:read`. */
    readonly weftEnabled: boolean;
    /** Whether a decision on one of the engine's reviews is being sent. */
    readonly submitting: boolean;
    readonly onSubmit: (reviewId: string, submission: ReviewDecisionSubmission) => void;
    /** Whether a decision or an answer on one of the Bureau's reviews is being sent. */
    readonly resolving: boolean;
    /** What became of the last decision or answer on a Bureau review, when it did not simply take effect. */
    readonly outcome: ReviewOutcome | undefined;
    readonly onResolve: (
      review: BureauReview,
      decision: ReviewDecision,
      reason: string | undefined,
    ) => void;
    readonly onAnswer: (review: BureauHumanWait, answer: string) => void;
  }

  let {
    bureauQuery,
    pendingQuery,
    completedQuery,
    weftEnabled,
    submitting,
    onSubmit,
    resolving,
    outcome,
    onResolve,
    onAnswer,
  }: ReviewsInboxProps = $props();

  const principalStore = getPrincipalStore();
  const queryClient = useQueryClient();

  const INBOX_STATES: readonly ReviewInboxState[] = ['pending', 'completed', 'timeout'];
  const STATE_LABELS: Readonly<Record<ReviewInboxState, string>> = {
    pending: 'Pending',
    completed: 'Decided',
    timeout: 'Timed out',
  };
  const NARROW_VIEWPORT_QUERY = '(max-width: 899px)';

  let inboxState = $state<ReviewInboxState>('pending');
  let selectedKey = $state<string | null>(null);
  let live = $state(false);
  let now = $state(Date.now());

  $effect(() => {
    const interval = setInterval(() => {
      now = Date.now();
    }, 1_000);
    return () => clearInterval(interval);
  });

  const isNarrowViewport = new MediaQuery(NARROW_VIEWPORT_QUERY, false);

  const bureauReviews = $derived(bureauQuery.data ?? []);
  const pending = $derived(weftEnabled ? pendingEntriesOnly(pendingQuery.data ?? []) : []);
  const completed = $derived(weftEnabled ? completedEntriesOnly(completedQuery.data ?? []) : []);
  const partitioned = $derived(partitionPendingReviews(pending, now));

  /** One list from both sources while reviews are pending, and the engine's alone once decided or timed out. */
  const visibleItems = $derived<readonly ReviewItem[]>(
    inboxState === 'pending'
      ? mergePendingReviews(bureauReviews, partitioned.pending)
      : inboxState === 'timeout'
        ? partitioned.timedOut.map(weftReviewItem)
        : completed.map(weftReviewItem),
  );

  /**
   * The queries behind the visible state. A query error must render the same fault banner every
   * other route surfaces (plan §10.4), not the false "all caught up" / "no decisions yet" empty
   * state a failed fetch would otherwise fall through to via `?? []`, and one source failing does
   * not hide the other's reviews.
   */
  const faults = $derived<readonly { error: unknown; retry: () => void }[]>(
    (inboxState === 'completed'
      ? weftEnabled
        ? [completedQuery]
        : []
      : [bureauQuery, ...(weftEnabled ? [pendingQuery] : [])]
    )
      .filter((query) => query.isError)
      .map((query) => ({ error: query.error, retry: () => void query.refetch() })),
  );

  $effect(() => {
    if (!visibleItems.some((item) => item.key === selectedKey)) {
      selectedKey = visibleItems[0]?.key ?? null;
    }
  });

  const selectedItem = $derived(visibleItems.find((item) => item.key === selectedKey) ?? null);

  const fleetSource = getFleetEventSource();
  const liveToggleGate = $derived(scopeGate(principalStore, ['events:read']));
  // `weft.reviews.decision.submit` requires `reviews:write`.
  const submitGate = $derived(scopeGate(principalStore, ['reviews:write']));

  $effect(() => {
    if (!live || liveToggleGate.disabled) return;

    return fleetSource.subscribe((frame) => {
      if (!isReviewFleetEventKind(frame.kind)) return;
      void invalidateReviewQueries(queryClient);
    });
  });

  const isLoading = $derived(
    bureauQuery.isPending || (weftEnabled && (pendingQuery.isPending || completedQuery.isPending)),
  );

  function emptyStateCopy(state: ReviewInboxState): { title: string; description: string } {
    if (state === 'pending') {
      return { title: REVIEWS_COPY.allCaughtUp, description: REVIEWS_COPY.nothingWaiting };
    }
    if (state === 'timeout') {
      return {
        title: 'Nothing timed out',
        description: 'No pending reviews have passed their deadline.',
      };
    }
    return { title: 'No decisions yet', description: 'Decided reviews appear here.' };
  }
</script>

<div class="weft-reviews-inbox">
  <div class="weft-reviews-inbox__toolbar">
    <SegmentedControl
      id="reviews-inbox-state"
      selectionMode="single"
      label="Review state"
      value={inboxState}
      onValueChange={(value) => (inboxState = value as ReviewInboxState)}
    >
      {#each INBOX_STATES as state (state)}
        <Segment value={state}>{STATE_LABELS[state]}</Segment>
      {/each}
    </SegmentedControl>

    <div class="weft-reviews-inbox__live">
      {#if live}
        <ConnectionIndicator status={fleetSource.status} />
      {/if}
      {#if liveToggleGate.disabled}
        <Tooltip text={liveToggleGate.title ?? ''}>
          <Toggle id="reviews-inbox-live" label="Live" checked={live} disabled />
        </Tooltip>
      {:else}
        <Toggle id="reviews-inbox-live" label="Live" bind:checked={live} />
      {/if}
    </div>
  </div>

  {#if isLoading}
    <div
      class="weft-reviews-inbox__skeleton"
      role="status"
      aria-busy="true"
      aria-label="Loading reviews"
    >
      <Skeleton height="4rem" />
      <Skeleton height="4rem" />
      <Skeleton height="4rem" />
    </div>
  {:else}
    <ResizablePanels
      class="weft-reviews-inbox__panels"
      orientation={isNarrowViewport.current ? 'vertical' : 'horizontal'}
      panes={[
        {
          id: 'list',
          label: 'Reviews list',
          defaultSize: { value: 300, unit: 'px' },
          minSize: { value: 220, unit: 'px' },
        },
        { id: 'detail', label: 'Review detail' },
      ]}
    >
      {#snippet children(pane)}
        {#if pane.id === 'list'}
          <div class="weft-reviews-inbox__list-pane">
            {#each faults as fault, index (index)}
              <QueryFaultBanner error={fault.error} onRetry={fault.retry} />
            {/each}
            {#if visibleItems.length === 0}
              {#if faults.length === 0}
                {@const copy = emptyStateCopy(inboxState)}
                <EmptyState
                  title={copy.title}
                  description={copy.description}
                  class="weft-reviews-inbox__empty-state"
                />
              {/if}
            {:else}
              <div class="weft-reviews-inbox__count">
                {visibleItems.length}
                {STATE_LABELS[inboxState].toLowerCase()}
              </div>
              <ul class="weft-reviews-inbox__list">
                {#each visibleItems as item (item.key)}
                  <li>
                    {#if item.source === 'bureau'}
                      <BureauReviewRow
                        review={item.review}
                        {now}
                        selected={item.key === selectedKey}
                        onSelect={(key) => (selectedKey = key)}
                      />
                    {:else if item.entry.status === 'pending'}
                      <PendingReviewRow
                        entry={item.entry}
                        {now}
                        selected={item.key === selectedKey}
                        onSelect={() => (selectedKey = item.key)}
                      />
                    {:else}
                      <CompletedReviewRow
                        entry={item.entry}
                        {now}
                        selected={item.key === selectedKey}
                        onSelect={() => (selectedKey = item.key)}
                      />
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {:else if selectedItem}
          <div class="weft-reviews-inbox__detail-pane">
            {#key selectedItem.key}
              {#if selectedItem.source === 'bureau'}
                {@const review = selectedItem.review}
                <BureauReviewDetail
                  {review}
                  {now}
                  submitting={resolving}
                  outcome={outcome?.reviewId === review.id ? outcome : undefined}
                  onResolve={(decision, reason) => onResolve(review, decision, reason)}
                  onAnswer={(answer) => {
                    if (review.kind === 'human-wait') onAnswer(review, answer);
                  }}
                />
              {:else}
                <ReviewDetailPanel
                  entry={selectedItem.entry}
                  {now}
                  {submitting}
                  {onSubmit}
                  {submitGate}
                />
              {/if}
            {/key}
          </div>
        {:else}
          <div class="weft-reviews-inbox__detail-pane">
            <EmptyState
              title={REVIEWS_COPY.noReviewSelected}
              description={REVIEWS_COPY.chooseReview}
              class="weft-reviews-inbox__empty-state"
            />
          </div>
        {/if}
      {/snippet}
    </ResizablePanels>
  {/if}
</div>
