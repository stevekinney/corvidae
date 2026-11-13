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
    /** Uses the compact actionable row when several approvals share one tool group. */
    layout?: 'decision' | 'row';
  };
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
  import type { ApprovalCardProps } from '@lostgradient/cinder';

  let {
    part,
    onApprovalResolve,
    onApprovalRequestAgain,
    layout = 'decision',
  }: ToolApprovalPartProps = $props();

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
      layout,
    };

    if (part.details?.approveLabel !== undefined) props.approveLabel = part.details.approveLabel;
    // The approval card owns its standard pause sentence. Chat adapter details must not duplicate
    // that sentence in the decision surface when the Cinder default is available.
    if (part.details?.facts !== undefined) props.facts = part.details.facts;
    if (part.details?.why !== undefined) props.why = part.details.why;
    // A decision made here: who, when, and the note that went with it.
    if (part.receipt !== undefined) {
      props.decidedBy = 'you';
      props.decidedAt = part.receipt.decidedAt;
      if (part.receipt.reason !== undefined) props.decisionNote = part.receipt.reason;
      if (part.receipt.result !== undefined) props.result = part.receipt.result;
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

  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  /**
   * When an expired approval lapsed, written as a message's time is: the time of day for today and
   * the date with it for another day. The card says that it expired; this says when, under it.
   */
  // The card reads Expired the moment a pending approval's deadline passes, whether or not the
  // host has said so; the clock turns once at the deadline so this line follows it.
  let now = $state(Date.now());
  $effect(() => {
    const expiresAt = part.action.expiresAt;
    if (part.state !== 'pending' || expiresAt === undefined) return;
    const remaining = Date.parse(expiresAt) - Date.now();
    if (Number.isNaN(remaining)) return;
    if (remaining <= 0) {
      now = Date.now();
      return;
    }
    const timer = setTimeout(() => (now = Date.now()), remaining);
    return () => clearTimeout(timer);
  });
  const expiredTime = $derived.by(() => {
    const expiresAt = part.action.expiresAt;
    if (expiresAt === undefined) return undefined;
    const passed = Date.parse(expiresAt) <= now;
    if (part.state !== 'expired' && !(part.state === 'pending' && passed)) return undefined;
    const lapsed = new Date(expiresAt);
    if (Number.isNaN(lapsed.getTime())) return undefined;
    const today = lapsed.toDateString() === new Date().toDateString();
    return {
      iso: expiresAt,
      text: (today ? timeFormatter : dateTimeFormatter).format(lapsed),
    };
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

{#if expiredTime !== undefined}
  <!-- The same element, size and colour as a message's time line, under the card and not in it. -->
  <div class="chat-approval-time">
    <time datetime={expiredTime.iso}><bdi>{expiredTime.text}</bdi></time>
  </div>
{/if}
