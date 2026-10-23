<script lang="ts">
  /**
   * The reviews inbox: everything waiting on a person, as one list to work through, the longest
   * waiting first. Each item is its own question with its decision inline (`bureau-review-item.svelte`).
   * The Bureau's pending reviews are the tool approvals and questions of the agents' runs. When the
   * principal may read them (`reviews:read`) and the engine has human reviews waiting, they follow
   * in their own section, "Engine reviews", with the engine's own decision form. There are no
   * Decided or Timed out states: the Bureau lists no review once it is resolved, so those were
   * the engine's, and an engine with none shows no sign of them. `index.svelte` owns the queries and
   * the mutations.
   */
  import { EmptyState, Skeleton } from '@lostgradient/cinder';
  import type { ReviewListEntry } from '@lostgradient/weft';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import type { BureauHumanWait, BureauReview, ReviewDecision } from '../../lib/bureau-reviews.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import BureauReviewItem, { type ReviewOutcome } from './bureau-review-item.svelte';
  import QueryFaultBanner from './query-fault-banner.svelte';
  import type { ReviewDecisionSubmission } from './review-decision-form.svelte';
  import ReviewDetailPanel from './review-detail-panel.svelte';
  import { partitionPendingReviews, pendingEntriesOnly, type ReviewQuery } from './review-domain.ts';
  import { mergePendingReviews } from './review-items.ts';

  interface ReviewsInboxProps {
    /** The Bureau's pending reviews. */
    readonly bureauQuery: ReviewQuery<readonly BureauReview[]>;
    /** The engine's pending reviews. Read only while `weftEnabled`. */
    readonly pendingQuery: ReviewQuery<ReviewListEntry[]>;
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
    /** How many things wait on the person, for the heading's badge. */
    waiting?: number;
  }

  let {
    bureauQuery,
    pendingQuery,
    weftEnabled,
    submitting,
    onSubmit,
    resolving,
    outcome,
    onResolve,
    onAnswer,
    waiting = $bindable(0),
  }: ReviewsInboxProps = $props();

  const principalStore = getPrincipalStore();
  const submitGate = $derived(scopeGate(principalStore, ['reviews:write']));

  let now = $state(Date.now());
  $effect(() => {
    const interval = setInterval(() => {
      now = Date.now();
    }, 1_000);
    return () => clearInterval(interval);
  });

  const bureauItems = $derived(
    mergePendingReviews(bureauQuery.data ?? [], []).flatMap((item) =>
      item.source === 'bureau' ? [item.review] : [],
    ),
  );
  const engineEntries = $derived(
    weftEnabled ? partitionPendingReviews(pendingEntriesOnly(pendingQuery.data ?? []), now).pending : [],
  );
  $effect(() => {
    waiting = bureauItems.length + engineEntries.length;
  });

  /** A query that failed shows the fault banner, and one source failing does not hide the other's reviews. */
  const faults = $derived<readonly { error: unknown; retry: () => void }[]>(
    [bureauQuery, ...(weftEnabled ? [pendingQuery] : [])]
      .filter((query) => query.isError)
      .map((query) => ({ error: query.error, retry: () => void query.refetch() })),
  );
  const isLoading = $derived(bureauQuery.isPending || (weftEnabled && pendingQuery.isPending));
</script>

<div class="ib-reviews">
  {#if isLoading}
    <div role="status" aria-busy="true" aria-label="Loading reviews">
      <Skeleton height="3rem" />
      <Skeleton height="3rem" />
    </div>
  {:else}
    {#each faults as fault, index (index)}
      <QueryFaultBanner error={fault.error} onRetry={fault.retry} />
    {/each}
    {#if waiting === 0 && faults.length === 0}
      <EmptyState title={REVIEWS_COPY.allCaughtUp} description={REVIEWS_COPY.nothingWaiting} />
    {/if}
    {#if bureauItems.length > 0}
      <ul class="ib-reviews__list" aria-label={REVIEWS_COPY.heading}>
        {#each bureauItems as review (review.id)}
          <BureauReviewItem
            {review}
            submitting={resolving}
            outcome={outcome?.reviewId === review.id ? outcome : undefined}
            onResolve={(decision, reason) => onResolve(review, decision, reason)}
            onAnswer={(answer) => {
              if (review.kind === 'human-wait') onAnswer(review, answer);
            }}
          />
        {/each}
      </ul>
    {/if}
    {#if engineEntries.length > 0}
      <section class="ib-reviews__engine" aria-labelledby="ib-reviews-engine">
        <h2 id="ib-reviews-engine" class="ib-reviews__heading">{REVIEWS_COPY.engineHeading}</h2>
        {#each engineEntries as entry (entry.reviewId)}
          <ReviewDetailPanel {entry} {now} {submitting} {onSubmit} {submitGate} />
        {/each}
      </section>
    {/if}
  {/if}
</div>
