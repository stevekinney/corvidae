<script lang="ts">
  /**
   * One tool approval, open: the question the tool asks, the line that says who asked, what the
   * call was given (and, for a command or a patch, what it would run), and the decision: Approve,
   * Deny with an optional note the agent reads, and, in a chat, Allow for the rest of this chat.
   * A decided approval shows the same, with what became of it in place of the buttons.
   */
  import {
    Alert,
    humanizeIdentifier,
    type ApprovalOperation,
    type ApprovalResolution,
    type ApprovalState,
  } from '@lostgradient/cinder';
  import {
    ToolApprovalPart,
    type ToolApprovalAction,
    type ToolApprovalMessagePart,
  } from '@lostgradient/chat';
  import {
    ReviewApprovalButtons,
    type ToolApprovalActions,
  } from '@lostgradient/bureau-client/reviews/ui';
  import type { Snippet } from 'svelte';

  import { getConnection } from '../../app/connection.svelte.ts';
  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { REVIEWS_COPY } from '../../app/copy/reviews.ts';
  import type { BureauToolApproval } from '../../lib/bureau-reviews.ts';
  import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
  import { approvalQuestion, argumentEntries, declaredSummary } from '../../lib/tool-text.ts';
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
    readonly onDecide: (resolution: ApprovalResolution) => void;
    readonly actions: ToolApprovalActions;
  }

  let {
    review,
    note = $bindable(''),
    deciding,
    outcome,
    onDecide,
    actions,
  }: ApprovalPaneProps = $props();

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
  const connection = getConnection();
  const waiting = $derived(review.status === 'pending');
  const toolLabel = $derived(humanizeIdentifier(review.approval.toolName, { casing: 'sentence' }));
  const question = $derived(
    approvalQuestion({
      toolName: toolLabel,
      arguments: review.approval.arguments,
      summary: declaredSummary(review.approval.action.message, review.approval.reason),
    }),
  );
  const action = $derived(
    review.approval.action.type === 'approval' ? review.approval.action : undefined,
  );
  // A pre-approval record can predate the action detail. It is still an approval row; retain the
  // review's arguments and render the safe, neutral operation instead of dropping the record.
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
  const approvalAction = $derived<ToolApprovalAction>(
    // Reviews resolves the stored arguments exactly as Bureau gave them; it has no edits or
    // snapshot field on its wire operation, so build its Chat action from the supported fields.
    {
      type: 'approval',
      risk: action?.risk ?? 'low',
      // `appearance.operation` below is the Bureau operation with its read-only arguments.
      // This action never reaches the Reviews resolve wire.
      operation: { kind: 'other' },
      policyVersion: 'bureau-review',
      idempotencyKey: `${review.id}:${review.round}`,
      ...(action?.message === undefined ? {} : { message: action.message }),
      ...(action?.consequence === undefined ? {} : { consequence: action.consequence }),
      ...(action?.expiresAt === undefined ? {} : { expiresAt: action.expiresAt }),
      ...(action?.irreversible === undefined ? {} : { irreversible: action.irreversible }),
      ...(action?.why === undefined ? {} : { why: action.why }),
    },
  );
  const state = $derived(states[review.status]);
  const closedNotice = $derived(
    review.status === 'revoked' || review.status === 'superseded'
      ? REVIEWS_COPY.approvalClosed[review.status]
      : undefined,
  );
  const resolution = $derived(review.resolution);
  const appearance = $derived({
    headingLevel: 2 as const,
    idempotencyKey: `${review.id}:${review.round}`,
    operation,
    policyVersion: 'bureau-review',
    question,
    tool: {
      name: review.approval.toolName,
      label: toolLabel,
      risk: action?.risk ?? 'low',
      irreversible: action?.risk === 'high',
    },
    ...(action?.consequence === undefined ? {} : { consequence: action.consequence }),
    ...(action?.expiresAt === undefined ? {} : { expiresAt: action.expiresAt }),
    ...(actions.canRemember ? { rememberScope: CHAT_COPY.approval.rememberScope } : {}),
    ...(connection.unreachable ? { disabledReason: CHAT_COPY.approval.unreachable } : {}),
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
  });
  const part = $derived({
    type: 'tool-approval',
    key: review.id,
    toolCallId: review.approval.callId,
    toolName: review.approval.toolName,
    action: approvalAction,
    state,
    resolutionInFlight: deciding !== undefined,
  } satisfies ToolApprovalMessagePart);
</script>

<div data-kind="tool-approval" data-review={review.id}>
  {#snippet actionRenderer(controls: Snippet)}
    <ReviewApprovalButtons {actions} label={question} {controls} />
  {/snippet}
  {#snippet source()}
    <ReviewSource {review} {waiting} />
    {#if review.effect?.kind === 'refund'}
      <p>
        {new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: review.effect.currency,
        }).format(review.effect.cents / 100)}
        for order {review.effect.orderId}.
        {review.effect.status === 'succeeded'
          ? 'Refunded'
          : review.effect.status === 'needs-reconciliation'
            ? 'Needs reconciliation'
            : review.effect.status === 'provider-pending'
              ? 'Refund pending'
              : review.effect.status === 'failed'
                ? 'Refund failed'
                : review.status === 'approved'
                  ? 'Approved'
                  : 'Awaiting approval'}
      </p>
    {/if}
    {#if !hasInput}
      <p>{REVIEWS_COPY.noInput}</p>
    {/if}
  {/snippet}
  <ToolApprovalPart
    {part}
    layout="detail"
    context={source}
    bind:reason={note}
    appearance={{ ...appearance, noteInitiallyOpen: true, actionRenderer }}
    onApprovalResolve={(_, resolution) => onDecide(resolution)}
  />
  {#if outcome !== undefined && outcome.tone !== 'danger'}
    <Alert variant={outcome.tone}>
      <p class="ib-decision__failure">
        {outcome.title}{outcome.message === '' ? '' : `: ${outcome.message}`}
      </p>
    </Alert>
  {/if}
</div>
