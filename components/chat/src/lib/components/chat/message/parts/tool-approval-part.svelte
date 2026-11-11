<script lang="ts" module>
  import type { ApprovalResolution } from '@lostgradient/cinder';
  import type { ToolApprovalMessagePart } from '../../utilities/types.ts';

  export type ToolApprovalPartProps = {
    /** The tool-approval render part. */
    part: ToolApprovalMessagePart;
    /** Requests a fresh approval after this tool call expires. */
    onApprovalRequestAgain?: ((toolCallId: string) => void) | undefined;
    /** Called when the user resolves the approval. */
    onApprovalResolve?:
      ((toolCallId: string, resolution: ApprovalResolution) => void | Promise<void>) | undefined;
  };
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
  import type { ApprovalCardProps } from '@lostgradient/cinder';

  let { part, onApprovalResolve, onApprovalRequestAgain }: ToolApprovalPartProps = $props();

  const canResolve = $derived(
    part.state === 'pending' && !part.resolutionInFlight && onApprovalResolve !== undefined,
  );
  const cardProps = $derived.by(() => {
    const props: ApprovalCardProps = {
      tool: {
        name: part.toolName,
        risk: part.action.risk,
        // The host's word on whether it can be undone; the wire action does not carry it.
        ...(part.details?.irreversible === undefined
          ? {}
          : { irreversible: part.details.irreversible }),
      },
      operation: part.action.operation,
      policyVersion: part.action.policyVersion,
      idempotencyKey: part.action.idempotencyKey,
      state: part.state,
      headingLevel: 4,
      // The explicit decision, which stays as a receipt once decided. The adapter adds what the
      // approval action does not carry: whether it can be undone, a named primary, facts.
      layout: 'decision',
    };

    if (part.details?.approveLabel !== undefined) props.approveLabel = part.details.approveLabel;
    if (part.details?.pauseSentence !== undefined) props.pauseSentence = part.details.pauseSentence;
    if (part.details?.facts !== undefined) props.facts = part.details.facts;
    if (part.details?.why !== undefined) props.why = part.details.why;
    // A decision made here: who, when, and the note that went with it.
    if (part.receipt !== undefined) {
      props.decidedBy = 'you';
      props.decidedAt = part.receipt.decidedAt;
      if (part.receipt.reason !== undefined) props.decisionNote = part.receipt.reason;
    }

    if (onApprovalRequestAgain !== undefined) {
      props.onAskAgain = () => onApprovalRequestAgain?.(part.toolCallId);
    }
    if (part.action.message !== undefined) props.question = part.action.message;
    if (part.action.sandbox !== undefined) props.sandbox = part.action.sandbox;
    if (part.action.env !== undefined) props.env = part.action.env;
    if (part.action.snapshotId !== undefined) props.snapshotId = part.action.snapshotId;
    if (part.action.expiresAt !== undefined) props.expiresAt = part.action.expiresAt;
    if (part.action.editableArgs !== undefined) props.editableArgs = part.action.editableArgs;

    return props;
  });

  function resolveApproval(resolution: ApprovalResolution): void {
    if (!canResolve) return;
    onApprovalResolve?.(part.toolCallId, resolution);
  }

  function handleKeydown(event: KeyboardEvent): void {
    // An armed irreversible press owns Escape: it reverts the arm and marks the key handled, so the
    // approval itself is not cancelled by the same keystroke.
    if (event.key !== 'Escape' || !canResolve || event.defaultPrevented) return;
    event.preventDefault();
    resolveApproval({ decision: 'cancel', remember: false });
  }
</script>

<ApprovalCard
  {...cardProps}
  data-cinder-tool-approval
  tabindex={-1}
  onkeydown={handleKeydown}
  {...canResolve ? { onResolve: resolveApproval } : {}}
/>
