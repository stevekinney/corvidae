<script lang="ts">
  /**
   * The decision bar of a workflow review that has no sections to decide one by one: a note for the
   * workflow (what to change, when it is sent back), and in the footer, beside what the workflow does
   * next, a secondary "Send back" and a primary "Approve". There is no Deny: a workflow review is
   * approved or sent back for changes. The reviewer is the caller, so nothing is typed to say who
   * decided. A review with sections keeps `review-decision-form.svelte`, which decides each section.
   * Both need `reviews:write`, and the buttons are held without it.
   */
  import { Button, Textarea, Tooltip } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy/reviews.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import type { ReviewDecisionSubmission } from './review-decision-form.svelte';

  interface WorkflowReviewBarProps {
    readonly reviewId: string;
    /** Whether a decision on this review is being sent, which holds the buttons. */
    readonly submitting: boolean;
    /** Who the caller is; a decision cannot be recorded without one. */
    readonly viewer?: string | undefined;
    /** `reviews:write` gate; open when omitted. */
    readonly submitGate?: ScopeGate | undefined;
    readonly onSubmit: (submission: ReviewDecisionSubmission) => void;
  }

  let {
    reviewId,
    submitting,
    viewer,
    submitGate = { disabled: false, title: undefined },
    onSubmit,
  }: WorkflowReviewBarProps = $props();

  let note = $state('');

  const canSubmit = $derived(
    !submitGate.disabled && !submitting && viewer !== undefined && viewer.trim() !== '',
  );

  function submit(decision: 'approved' | 'needs-changes'): void {
    if (!canSubmit || viewer === undefined) return;
    const feedback = note.trim();
    onSubmit({
      decision,
      reviewer: viewer.trim(),
      ...(feedback === '' ? {} : { feedback }),
    });
  }
</script>

<div class="ib-review-pane__decision" data-testid="workflow-review-bar">
  <Textarea
    id={`review-${reviewId}-note`}
    label={REVIEWS_COPY.noteLabel}
    description={REVIEWS_COPY.workflow.noteDescription}
    placeholder={REVIEWS_COPY.workflow.notePlaceholder}
    bind:value={note}
    rows={3}
    disabled={submitting}
  />
</div>
<div class="ib-review-pane__footer">
  <p class="ib-review-pane__footer-note">{REVIEWS_COPY.workflow.footer}</p>
  <Tooltip text={submitGate.title ?? ''}>
    <Button
      data-changes
      variant="secondary"
      label={REVIEWS_COPY.workflow.sendBack}
      disabled={!canSubmit}
      onclick={() => submit('needs-changes')}
    />
  </Tooltip>
  <Tooltip text={submitGate.title ?? ''}>
    <Button
      data-changes
      variant="primary"
      label={REVIEWS_COPY.workflow.approve}
      disabled={!canSubmit}
      onclick={() => submit('approved')}
    />
  </Tooltip>
</div>
