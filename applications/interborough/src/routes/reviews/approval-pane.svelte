<script lang="ts">
  /**
   * One tool approval, open: the question the tool asks, the line that says who asked, what the
   * call was given (and, for a command or a patch, what it would run), and the decision: Approve,
   * Deny with an optional note the agent reads, and, in a chat, Allow for the rest of this chat.
   * A decided approval shows the same, with what became of it in place of the buttons.
   */
  import {
    Alert,
    ApprovalCard,
    humanizeIdentifier,
    type ApprovalState,
  } from '@lostgradient/cinder';

  import type { BureauToolApproval } from '../../lib/bureau-reviews.ts';
  import { approvalQuestion, declaredSummary, reasonSaysAlways } from '../../lib/tool-text.ts';
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
  /** The tool as a person says it ("Issue refund"), beside its identifier. */
  const toolLabel = $derived(humanizeIdentifier(review.approval.toolName, { casing: 'sentence' }));
  /**
   * Whether the tool asks on every call (its mode is Always), which allowing it for the rest of the
   * chat would not change, so the choice is not offered.
   */
  const alwaysAsks = $derived(reasonSaysAlways(review.approval.reason));
  const action = $derived(
    review.approval.action.type === 'approval' ? review.approval.action : undefined,
  );
  const operation = $derived.by(() => {
    if (action === undefined) return { kind: 'other' } as const;
    return { ...action.operation, argsPreview: review.approval.arguments };
  });
  const state = $derived<ApprovalState>(review.status === 'rejected' ? 'denied' : review.status);
  const resolution = $derived(review.resolution);

  function decide(resolution: {
    readonly decision: 'approve' | 'deny';
    readonly reason?: string;
    readonly remember: boolean;
  }): void {
    onDecide(
      resolution.decision === 'deny' ? 'deny' : resolution.remember ? 'remember' : 'approve',
    );
  }
</script>

<div data-kind="tool-approval" data-review={review.id}>
  {#snippet source()}
    <ReviewSource {review} {waiting} />
  {/snippet}
  <ApprovalCard
    layout="detail"
    tool={{
      name: review.approval.toolName,
      label: toolLabel,
      risk: action?.risk ?? 'low',
      irreversible: action?.risk === 'high',
    }}
    {operation}
    policyVersion="bureau-review"
    idempotencyKey={`${review.id}:${review.round}`}
    expiresAt={action?.expiresAt}
    {state}
    headingLevel={2}
    {question}
    context={source}
    consequence={action === undefined
      ? undefined
      : declaredSummary(action.message, review.approval.reason)}
    rememberScope={alwaysAsks ? undefined : 'the rest of this chat'}
    bind:reason={note}
    noteInitiallyOpen
    resolving={deciding ? 'approve' : undefined}
    failure={outcome?.tone === 'danger'
      ? { summary: outcome.title, detail: outcome.message }
      : undefined}
    decidedBy={resolution?.decidedBy}
    decidedAt={resolution?.decidedAt}
    decisionNote={resolution?.reason}
    onResolve={decide}
  />
  {#if outcome !== undefined}
    <Alert variant={outcome.tone}>
      <p class="ib-decision__failure">
        {outcome.title}{outcome.message === '' ? '' : `: ${outcome.message}`}
      </p>
    </Alert>
  {/if}
</div>
