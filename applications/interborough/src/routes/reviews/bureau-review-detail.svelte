<script lang="ts">
  /**
   * The detail pane for one Bureau review. A tool approval shows the tool, its arguments, and why
   * it paused, with the decision form (`bureau-review-form.svelte`). A question shows what is asked,
   * with one text field whose answer goes to the run through `bureau.tasks.respond`.
   */
  import { Alert, Badge, Button, Textarea } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import type { BureauReview, ReviewDecision } from '../../lib/bureau-reviews.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import BureauReviewForm from './bureau-review-form.svelte';

  /** A decision or an answer that did not simply take effect, and why. */
  export interface ReviewOutcome {
    readonly tone: 'danger' | 'warning';
    readonly title: string;
    readonly message: string;
  }

  interface BureauReviewDetailProps {
    readonly review: BureauReview;
    readonly now: number;
    /** Whether a decision or an answer is being sent. */
    readonly submitting: boolean;
    /** What became of the last decision or answer, when it was not simply recorded. */
    readonly outcome: ReviewOutcome | undefined;
    readonly onResolve: (decision: ReviewDecision, reason: string | undefined) => void;
    readonly onAnswer: (answer: string) => void;
  }

  let { review, now, submitting, outcome, onResolve, onAnswer }: BureauReviewDetailProps = $props();

  let answer = $state('');

  const argumentsText = $derived(
    review.kind === 'tool-approval'
      ? JSON.stringify(review.approval.arguments ?? null, null, 2)
      : '',
  );

  function send(event: SubmitEvent): void {
    event.preventDefault();
    if (submitting || answer.trim() === '') return;
    onAnswer(answer.trim());
  }
</script>

<div class="weft-review-detail" data-kind={review.kind}>
  <header class="weft-review-detail__header">
    <h2 class="weft-review-detail__title">
      {review.kind === 'tool-approval' ? REVIEWS_COPY.toolApproval : REVIEWS_COPY.humanWait}
    </h2>
    <p class="weft-review-detail__meta">
      {#if review.agentName !== undefined}{REVIEWS_COPY.agentFact} {review.agentName} ·{/if}
      {REVIEWS_COPY.requestedFact.toLowerCase()}
      {formatRelativeTime(review.requestedAt, now)}
    </p>
  </header>

  {#if outcome !== undefined}
    <Alert variant={outcome.tone}>
      <p class="weft-bureau-review-outcome__title">{outcome.title}</p>
      {#if outcome.message !== ''}
        <p class="weft-bureau-review-outcome__message">{outcome.message}</p>
      {/if}
    </Alert>
  {/if}

  {#if review.kind === 'tool-approval'}
    <dl class="weft-bureau-review-facts">
      <dt>{REVIEWS_COPY.toolLabel}</dt>
      <dd><code>{review.approval.toolName}</code></dd>
      {#if review.approval.reason !== undefined}
        <dt>{REVIEWS_COPY.reasonFact}</dt>
        <dd>{review.approval.reason}</dd>
      {/if}
      {#if review.approval.action.message !== undefined}
        <dt>{REVIEWS_COPY.messageFact}</dt>
        <dd>{review.approval.action.message}</dd>
      {/if}
      {#if review.approval.action.type === 'approval'}
        <dt>{REVIEWS_COPY.riskFact}</dt>
        <dd>
          <Badge
            variant={review.approval.action.risk === 'high'
              ? 'danger'
              : review.approval.action.risk === 'medium'
                ? 'warning'
                : 'neutral'}
            size="sm">{review.approval.action.risk}</Badge
          >
        </dd>
      {/if}
    </dl>
    <div class="weft-bureau-review-arguments">
      <span class="weft-bureau-review-arguments__label">{REVIEWS_COPY.argumentsLabel}</span>
      <pre class="weft-bureau-review-arguments__body">{argumentsText}</pre>
    </div>
    <BureauReviewForm reviewId={review.id} {submitting} {onResolve} />
  {:else}
    <p class="weft-bureau-review-prompt">{review.prompt ?? review.signalName}</p>
    <form class="weft-bureau-review-form" onsubmit={send}>
      <Textarea
        id={`bureau-review-answer-${review.id}`}
        label={REVIEWS_COPY.answerLabel}
        bind:value={answer}
        rows={3}
      />
      <div class="weft-bureau-review-form__actions">
        <Button
          type="submit"
          variant="primary"
          label={REVIEWS_COPY.sendAnswer}
          loading={submitting}
          disabled={submitting || answer.trim() === ''}
        />
      </div>
    </form>
  {/if}
</div>
