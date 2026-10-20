<script lang="ts">
  /**
   * `/reviews`: everything waiting on the caller, the Bureau's tool approvals and questions and the
   * engine's human reviews, in one inbox. This owns the queries and the mutations once and hands
   * them down. The Bureau's list is the view's own (the view frame has asked it, so a refusal is the
   * frame's `forbidden`). The engine's reviews are read only while the principal holds
   * `reviews:read`, which is also what decides whether they count; `reviews:write` is what its
   * decision form needs, and the form disables its own submit without it.
   */
  import { Alert } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import type { BureauHumanWait, BureauReview, ReviewDecision } from '../../lib/bureau-reviews.ts';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { createPendingCommandKey } from '../../lib/pending-command-key.ts';
  import { getPrincipalStore, isForbidden } from '../../lib/scopes.svelte.ts';
  import type { ReviewOutcome } from './bureau-review-detail.svelte';
  import type { ReviewDecisionSubmission } from './review-decision-form.svelte';
  import {
    answerHumanWaitMutation,
    bureauReviewsQuery,
    resolveBureauReviewMutation,
    reviewListQuery,
    submitReviewDecisionMutation,
  } from './reviews-data.ts';
  import ReviewsInbox from './reviews-inbox.svelte';

  const client = getClient();
  const principalStore = getPrincipalStore();

  /** The engine's reviews are read only for a principal that may. */
  const weftEnabled = $derived(principalStore.hasScope('reviews:read'));

  const bureauQuery = bureauReviewsQuery();
  const pendingQuery = reviewListQuery(client, () => 'pending', { enabled: () => weftEnabled });
  const completedQuery = reviewListQuery(client, () => 'completed', {
    enabled: () => weftEnabled,
  });
  const decisionMutation = submitReviewDecisionMutation(client);
  const resolveMutation = resolveBureauReviewMutation();
  const answerMutation = answerHumanWaitMutation();
  // One key stays with an answer until the Bureau confirms it, so a retry after a lost response is
  // the same command and the Bureau answers it from its ledger.
  const answerKey = createPendingCommandKey();

  $effect(() => {
    if (isForbidden(pendingQuery.error) || isForbidden(completedQuery.error)) {
      principalStore.denyScope('reviews:read');
    }
  });

  function submitDecision(reviewId: string, submission: ReviewDecisionSubmission): void {
    decisionMutation.mutate({
      reviewId,
      options: {
        decision: submission.decision,
        reviewer: submission.reviewer,
        ...(submission.feedback !== undefined ? { feedback: submission.feedback } : {}),
        ...(submission.sectionDecisions !== undefined
          ? { sectionDecisions: submission.sectionDecisions }
          : {}),
      },
    });
  }

  /** What became of the last decision or answer on a Bureau review, when it did not simply take effect. */
  let outcome = $state<ReviewOutcome | undefined>(undefined);
  /** Whether a decision took effect and only its write into the conversation failed. */
  let notWritten = $state(false);

  function resolve(
    review: BureauReview,
    decision: ReviewDecision,
    reason: string | undefined,
  ): void {
    outcome = undefined;
    notWritten = false;
    resolveMutation.mutate(
      { id: review.id, decision, ...(reason === undefined ? {} : { reason }) },
      {
        onSuccess: (resolution) => {
          if (resolution.outcomeNotWritten === true) {
            // The Bureau drops a review from its pending list as it commits the decision, which is
            // before it signals that the outcome could not be written. The list is read again at
            // once, so the review is gone and no pane could carry this: it belongs to the page,
            // and stays until the operator dismisses it.
            notWritten = true;
          } else if (resolution.receipt === 'superseded') {
            outcome = {
              reviewId: review.id,
              tone: 'warning',
              title: REVIEWS_COPY.superseded,
              message: '',
            };
          }
        },
        onError: (error) => {
          outcome = {
            reviewId: review.id,
            tone: 'danger',
            title: REVIEWS_COPY.decisionFailed,
            message: faultTreatment(error).message,
          };
        },
      },
    );
  }

  function answer(review: BureauHumanWait, text: string): void {
    outcome = undefined;
    answerMutation.mutate(
      {
        messageId: answerKey.keyFor(review.id, text),
        taskId: review.runId,
        answer: text,
        signalName: review.signalName,
      },
      {
        onSuccess: () => answerKey.confirmed(),
        onError: (error) => {
          outcome = {
            reviewId: review.id,
            tone: 'danger',
            title: REVIEWS_COPY.answerFailed,
            message: faultTreatment(error).message,
          };
        },
      },
    );
  }
</script>

<div class="weft-reviews-route">
  <div class="weft-reviews-route__header">
    <h1 class="weft-reviews-route__title">{REVIEWS_COPY.heading}</h1>
  </div>

  {#if notWritten}
    <Alert variant="warning" dismissible onDismiss={() => (notWritten = false)}>
      <p class="weft-bureau-review-outcome__title">{REVIEWS_COPY.outcomeNotWritten.title}</p>
      <p class="weft-bureau-review-outcome__message">{REVIEWS_COPY.outcomeNotWritten.message}</p>
    </Alert>
  {/if}

  <ReviewsInbox
    {bureauQuery}
    {pendingQuery}
    {completedQuery}
    {weftEnabled}
    submitting={decisionMutation.isPending}
    onSubmit={submitDecision}
    resolving={resolveMutation.isPending || answerMutation.isPending}
    {outcome}
    onResolve={resolve}
    onAnswer={answer}
  />
</div>
