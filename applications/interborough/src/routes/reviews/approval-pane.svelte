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
    type ApprovalOperation,
    type ApprovalCardProps,
    type ApprovalResolution,
    type ApprovalState,
  } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy/reviews.ts';
  import type { BureauToolApproval } from '../../lib/bureau-reviews.ts';
  import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
  import {
    approvalQuestion,
    argumentEntries,
    declaredSummary,
    reasonSaysAlways,
  } from '../../lib/tool-text.ts';
  import { decidedByName } from './review-items.ts';
  import ReviewSource from './review-source.svelte';
  import type { ReviewOutcome } from './review-outcome.ts';

  interface ApprovalPaneProps {
    readonly review: BureauToolApproval;
    /** The note sent with a denial. The page owns it, so the D key sends what is typed. */
    note: string;
    /** The decision being sent, which names and holds its matching button. */
    readonly deciding: 'approve' | 'deny' | undefined;
    /** What became of the last decision, when it was not simply recorded. */
    readonly outcome: ReviewOutcome | undefined;
    readonly onDecide: (decision: 'approve' | 'deny' | 'remember') => void;
  }

  let { review, note = $bindable(''), deciding, outcome, onDecide }: ApprovalPaneProps = $props();

  const states = {
    pending: 'pending',
    approved: 'approved',
    denied: 'denied',
    rejected: 'denied',
    expired: 'expired',
    canceled: 'cancelled',
    revoked: 'unavailable',
    superseded: 'unavailable',
  } satisfies Record<BureauToolApproval['status'], ApprovalState>;
  const principalStore = getPrincipalStore();
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
  const hasInput = $derived(argumentEntries(review.approval.arguments).length > 0);
  const operation = $derived.by((): ApprovalOperation => {
    const declared = action?.operation;
    const argsPreview = hasInput ? review.approval.arguments : undefined;
    if (declared === undefined) return { kind: 'other', argsPreview };
    if (declared.kind === 'file-write') {
      return { ...declared, filesTouched: [...declared.filesTouched], argsPreview };
    }
    const { filesTouched, ...operationFields } = declared;
    return {
      ...operationFields,
      ...(filesTouched === undefined ? {} : { filesTouched: [...filesTouched] }),
      argsPreview,
    };
  });
  const state = $derived(states[review.status]);
  const closedNotice = $derived(
    review.status === 'revoked' || review.status === 'superseded'
      ? REVIEWS_COPY.approvalClosed[review.status]
      : undefined,
  );
  const resolution = $derived(review.resolution);
  const optionalCardProps = $derived({
    ...(action?.expiresAt === undefined ? {} : { expiresAt: action.expiresAt }),
    ...(alwaysAsks ? {} : { rememberScope: 'the rest of this chat' }),
    ...(deciding === undefined ? {} : { resolving: deciding }),
    ...(outcome?.tone === 'danger'
      ? { failure: { summary: outcome.title, detail: outcome.message } }
      : {}),
    ...(resolution === undefined
      ? {}
      : {
          decidedBy: decidedByName(
            resolution.decidedBy,
            principalStore.principal?.subject ?? undefined,
          ),
          decidedAt: resolution.decidedAt,
          ...(resolution.reason === undefined ? {} : { decisionNote: resolution.reason }),
        }),
    ...(review.status === 'rejected' ? { outcomeLabel: REVIEWS_COPY.decided.rejected } : {}),
    ...(closedNotice === undefined ? {} : { notice: closedNotice }),
  } satisfies Partial<ApprovalCardProps>);

  function decide(choice: ApprovalResolution): void {
    if (choice.decision === 'deny') onDecide('deny');
    if (choice.decision === 'approve') onDecide(choice.remember ? 'remember' : 'approve');
  }
</script>

<div data-kind="tool-approval" data-review={review.id}>
  {#snippet source()}
    <ReviewSource {review} {waiting} />
    {#if !hasInput}
      <p>{REVIEWS_COPY.noInput}</p>
    {/if}
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
    {state}
    headingLevel={2}
    {question}
    context={source}
    bind:reason={note}
    noteInitiallyOpen
    {...optionalCardProps}
    onResolve={decide}
  />
  {#if outcome !== undefined && outcome.tone !== 'danger'}
    <Alert variant={outcome.tone}>
      <p class="ib-decision__failure">
        {outcome.title}{outcome.message === '' ? '' : `: ${outcome.message}`}
      </p>
    </Alert>
  {/if}
</div>
