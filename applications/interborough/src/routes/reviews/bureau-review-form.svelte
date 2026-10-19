<script lang="ts">
  /**
   * The decision form for a Bureau review. It is shaped for `bureau.reviews.resolve`'s
   * `{ id, decision, reason }`, not for the engine's review form (`review-decision-form.svelte`),
   * which records a reviewer's name, feedback, and a decision on each section of an artifact. Here a
   * review is approved, denied, or rejected, with a reason that a rejection cannot be sent without.
   */
  import { Button, Textarea } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import type { ReviewDecision } from '../../lib/bureau-reviews.ts';

  interface BureauReviewFormProps {
    reviewId: string;
    /** Whether a decision is being sent, which holds every button. */
    submitting: boolean;
    onResolve: (decision: ReviewDecision, reason: string | undefined) => void;
  }

  let { reviewId, submitting, onResolve }: BureauReviewFormProps = $props();

  let reason = $state('');
  const trimmed = $derived(reason.trim());

  function decide(decision: ReviewDecision): void {
    if (submitting) return;
    if (decision === 'reject' && trimmed === '') return;
    onResolve(decision, trimmed === '' ? undefined : trimmed);
  }
</script>

<form class="weft-bureau-review-form" onsubmit={(event) => event.preventDefault()}>
  <Textarea
    id={`bureau-review-reason-${reviewId}`}
    label={REVIEWS_COPY.reasonLabel}
    description={REVIEWS_COPY.reasonDescription}
    bind:value={reason}
    rows={3}
  />
  <div class="weft-bureau-review-form__actions">
    <Button
      type="button"
      variant="primary"
      label={REVIEWS_COPY.approve}
      disabled={submitting}
      onclick={() => decide('approve')}
    />
    <Button
      type="button"
      variant="secondary"
      label={REVIEWS_COPY.deny}
      disabled={submitting}
      onclick={() => decide('deny')}
    />
    <Button
      type="button"
      variant="danger"
      label={REVIEWS_COPY.reject}
      disabled={submitting || trimmed === ''}
      onclick={() => decide('reject')}
    />
  </div>
</form>
