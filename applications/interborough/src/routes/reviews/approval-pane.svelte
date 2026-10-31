<script lang="ts">
  /**
   * One tool approval, open: the question the tool asks, the line that says who asked, what the
   * call was given (and, for a command or a patch, what it would run), and the decision: Approve,
   * Deny with an optional note the agent reads, and, in a chat, Allow for the rest of this chat.
   * A decided approval shows the same, with what became of it in place of the buttons.
   */
  import { Alert, Button, Input } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import type { BureauToolApproval } from '../../lib/bureau-reviews.ts';
  import IdentifierText from '../../lib/identifier-text.svelte';
  import { approvalQuestion, argumentEntries, declaredSummary } from '../../lib/tool-text.ts';
  import BureauReviewOperation from './bureau-review-operation.svelte';
  import ReviewResolution from './review-resolution.svelte';
  import ReviewSource from './review-source.svelte';
  import type { ReviewOutcome } from './review-outcome.ts';

  interface ApprovalPaneProps {
    readonly review: BureauToolApproval;
    /** The note sent with a denial. The page owns it, so the D key sends what is typed. */
    note: string;
    /** Whether a decision is being sent, which holds the buttons. */
    readonly deciding: boolean;
    /** What became of the last decision, when it was not simply recorded. */
    readonly outcome: ReviewOutcome | undefined;
    readonly onDecide: (decision: 'approve' | 'deny' | 'remember') => void;
  }

  let { review, note = $bindable(''), deciding, outcome, onDecide }: ApprovalPaneProps = $props();

  const waiting = $derived(review.status === 'pending');
  const question = $derived(
    approvalQuestion({
      toolName: review.approval.toolName,
      arguments: review.approval.arguments,
      summary: declaredSummary(review.approval.action.message, review.approval.reason),
    }),
  );
  const entries = $derived(argumentEntries(review.approval.arguments));
  const operation = $derived(
    review.approval.action.type === 'approval' ? review.approval.action.operation : undefined,
  );
</script>

<div class="ib-review-pane" data-kind="tool-approval" data-review={review.id}>
  <h2 class="ib-review-pane__question" id={`review-${review.id}-question`}>
    <IdentifierText text={question} identifiers={[review.approval.toolName]} />
  </h2>
  <ReviewSource {review} {waiting} />
  <section class="ib-review-pane__input" aria-label={REVIEWS_COPY.inputLabel}>
    {#if entries.length === 0}
      <p class="ib-review-pane__note">{REVIEWS_COPY.noInput}</p>
    {:else}
      <dl class="ib-tool__details">
        {#each entries as [key, value] (key)}
          <dt>{key}</dt>
          <dd>{value}</dd>
        {/each}
      </dl>
    {/if}
    {#if operation !== undefined}
      <BureauReviewOperation {operation} />
    {/if}
  </section>
  {#if waiting}
    <div class="ib-review-pane__decision">
      <Input
        id={`review-${review.id}-note`}
        label={REVIEWS_COPY.noteLabel}
        labelVisible={false}
        placeholder={REVIEWS_COPY.noteLabel}
        bind:value={note}
        disabled={deciding}
      />
      <div
        class="ib-review-pane__actions"
        role="group"
        aria-labelledby={`review-${review.id}-question`}
      >
        <Button
          data-changes
          variant="primary"
          disabled={deciding}
          onclick={() => onDecide('approve')}>{REVIEWS_COPY.approve}</Button
        >
        <Button
          data-changes
          variant="secondary"
          disabled={deciding}
          onclick={() => onDecide('deny')}>{REVIEWS_COPY.deny}</Button
        >
        <Button
          data-changes
          variant="ghost"
          disabled={deciding}
          onclick={() => onDecide('remember')}>{REVIEWS_COPY.allowForChat}</Button
        >
      </div>
    </div>
  {:else}
    <ReviewResolution {review} />
  {/if}
  {#if outcome !== undefined}
    <Alert variant={outcome.tone}>
      <p class="ib-decision__failure">
        {outcome.title}{outcome.message === '' ? '' : `: ${outcome.message}`}
      </p>
    </Alert>
  {/if}
</div>
