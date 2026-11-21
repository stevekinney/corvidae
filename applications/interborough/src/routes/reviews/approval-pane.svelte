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
    type ApprovalResolution,
  } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { REVIEWS_COPY } from '../../app/copy/reviews.ts';
  import type { BureauToolApproval } from '../../lib/bureau-reviews.ts';
  import IdentifierText from '../../lib/identifier-text.svelte';
  import { approvalQuestion, declaredSummary, reasonSaysAlways } from '../../lib/tool-text.ts';
  import BureauReviewOperation from './bureau-review-operation.svelte';
  import { inputParts } from './review-items.ts';
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
    readonly onDecide: (resolution: ApprovalResolution) => void;
  }

  let { review, note = $bindable(''), deciding, outcome, onDecide }: ApprovalPaneProps = $props();

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
  const operation = $derived(action?.operation);
  const argsPreview = $derived.by((): unknown => {
    const args = review.approval.arguments;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return args;
    const { cents, ...fields } = Object.fromEntries(Object.entries(args));
    if (typeof cents !== 'number') return args;
    // When the tool supplied a matching currency preview, keep those words beside the other
    // inputs. Otherwise state the unit without assuming the tool's currency.
    const amount = /(?:^|\s)(\$\d[\d,]*\.\d{2})\?*$/.exec(question)?.[1];
    return amount !== undefined && Math.round(Number(amount.replace(/[^\d.]/g, '')) * 100) === cents
      ? { ...fields, Amount: amount }
      : { ...fields, 'Amount in cents': cents };
  });
  const cardOperation = $derived.by((): ApprovalOperation => {
    const files = operation?.filesTouched;
    const preview = { argsPreview, ...(files === undefined ? {} : { filesTouched: [...files] }) };
    switch (operation?.kind) {
      case 'file-write':
        return { kind: 'file-write', filesTouched: [...operation.filesTouched], argsPreview };
      case 'command':
        return { kind: 'command', command: operation.command, ...preview };
      case 'patch':
        return { kind: 'patch', diff: operation.diff, ...preview };
      default:
        return { kind: 'other', ...preview };
    }
  });
  const risk = $derived(action?.risk ?? 'low');
  let lastDecision = $state<'approve' | 'deny'>('approve');
  /**
   * Whether the tool asks on every call (its mode is Always), which allowing it for the rest of the
   * chat would not change, so the choice is not offered.
   */
  const alwaysAsks = $derived(reasonSaysAlways(review.approval.reason));
</script>

<div class="ib-review-pane" data-kind="tool-approval" data-review={review.id}>
  {#if waiting}
    <ApprovalCard
      layout="row"
      class="ib-review-pane__decision"
      headingLevel={2}
      state="pending"
      {question}
      tool={{
        name: review.approval.toolName,
        label: toolLabel,
        risk,
        irreversible: risk === 'high',
      }}
      operation={cardOperation}
      policyVersion={review.id}
      idempotencyKey={`${review.id}:${String(review.round)}`}
      {...action?.expiresAt === undefined ? {} : { expiresAt: action.expiresAt }}
      {...alwaysAsks ? {} : { rememberScope: CHAT_COPY.approval.rememberScope }}
      {...deciding ? { resolving: lastDecision } : {}}
      bind:draftNote={note}
      onResolve={(resolution) => {
        lastDecision = resolution.decision === 'deny' ? 'deny' : 'approve';
        onDecide(resolution);
      }}
    >
      {#snippet context()}<ReviewSource {review} {waiting} />{/snippet}
    </ApprovalCard>
  {:else}
    {@const entries = inputParts(review.approval.arguments)}
    <p class="ib-review-pane__eyebrow">{REVIEWS_COPY.toolApproval}</p>
    <h2 class="ib-review-pane__question">
      <IdentifierText text={question} identifiers={[review.approval.toolName]} />
    </h2>
    <ReviewSource {review} {waiting} />
    {#if entries.length > 0 || operation !== undefined}
      <section class="ib-review-pane__input" aria-label={REVIEWS_COPY.inputLabel}>
        {#if entries.length > 0}
          <p class="ib-review-pane__input-line" data-testid="review-input-line">
            <!-- prettier-ignore -->
            {#each entries as [key, value], index (index)}{#if index > 0}{', '}{/if}<span class="ib-review-pane__input-key">{key}</span> {value}{/each}
          </p>
        {/if}
        {#if operation !== undefined}
          <BureauReviewOperation {operation} />
        {/if}
      </section>
    {/if}
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
