<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { ApprovalCardProps, ApprovalResolution } from '@lostgradient/cinder';
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
    layout?: 'decision' | 'row' | 'detail';
    /** Host-specific card presentation, including an explicit in-flight progress state. */
    appearance?: Partial<
      Pick<
        ApprovalCardProps,
        | 'context'
        | 'consequence'
        | 'decidedAt'
        | 'decidedBy'
        | 'decisionNote'
        | 'disabledReason'
        | 'eyebrow'
        | 'failure'
        | 'footnote'
        | 'headingLevel'
        | 'inputLabel'
        | 'idempotencyKey'
        | 'expiresAt'
        | 'noteInitiallyOpen'
        | 'notice'
        | 'operation'
        | 'outcomeLabel'
        | 'policyVersion'
        | 'question'
        | 'requestedAt'
        | 'rememberScope'
        | 'resolving'
        | 'source'
        | 'sourceHref'
        | 'sourceIn'
        | 'sourceInHref'
        | 'sourcePrefix'
        | 'tool'
        | 'toolPrefix'
        | 'view'
      >
    >;
    /** Host content rendered above the shared approval's detail. */
    context?: Snippet;
    /** A host-owned note, retained while the approval is open. */
    reason?: string;
    /** The reader's own word, for a decision the reader made. Default `you`. */
    youLabel?: string;
  };
</script>

<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';

  let {
    part,
    onApprovalResolve,
    onApprovalRequestAgain,
    layout = 'decision',
    appearance,
    context,
    reason = $bindable(''),
    youLabel = 'you',
  }: ToolApprovalPartProps = $props();

  // Ordinary Chat hides actions once it has sent an answer. A detail host that supplies the exact
  // progress state keeps Cinder's disabled, labelled action mounted instead.
  const canResolve = $derived(
    part.state === 'pending' &&
      onApprovalResolve !== undefined &&
      (!part.resolutionInFlight || appearance?.resolving !== undefined),
  );
  // The host's word first, then the tool's own on the approval action: a host that knows better
  // can say so, while an action stored before these fields existed carries neither detail.
  const irreversible = $derived(part.details?.irreversible ?? part.action.irreversible);
  const why = $derived(part.details?.why ?? part.action.why);
  const cardProps = $derived.by(() => {
    const props: ApprovalCardProps = {
      tool: {
        name: part.toolName,
        risk: part.action.risk,
        ...(irreversible === undefined ? {} : { irreversible }),
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
    if (why !== undefined) props.why = why;
    if (part.action.consequence !== undefined) props.consequence = part.action.consequence;
    // A decision: who, when, where when it was not here (a link to it when the host gave one), and
    // the note that went with it. One made here, or recorded by the reader, reads as "you".
    if (part.receipt !== undefined) {
      props.decidedBy = part.receipt.decidedBy ?? youLabel;
      props.decidedAt = part.receipt.decidedAt;
      if (part.receipt.decidedIn !== undefined) props.decidedIn = part.receipt.decidedIn;
      if (part.receipt.decidedInHref !== undefined) {
        props.decidedInHref = part.receipt.decidedInHref;
      }
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
    if (context !== undefined) props.context = context;

    Object.assign(props, appearance);

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
  // Browsers clamp a timeout to a signed 32-bit delay. Re-arm a long-lived approval at that bound
  // instead of overflowing it to an immediate timer, which would repeatedly wake the component.
  const MAX_TIMEOUT_DELAY = 2_147_483_647;
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
    const timer = setTimeout(() => (now = Date.now()), Math.min(remaining, MAX_TIMEOUT_DELAY));
    return () => clearTimeout(timer);
  });
  /** Writes a moment as a message's time is: the time of day for today, the date with it otherwise. */
  function settledMoment(moment: Date, iso: string): { iso: string; text: string } | undefined {
    if (Number.isNaN(moment.getTime())) return undefined;
    const today = moment.toDateString() === new Date().toDateString();
    return { iso, text: (today ? timeFormatter : dateTimeFormatter).format(moment) };
  }
  /**
   * When the card settled, under it: an expired card's deadline, or the moment an approval or a
   * denial was decided. The three settled states are one pattern, and none holds its time inside.
   */
  const expiredTime = $derived.by(() => {
    if (
      part.state === 'approved' ||
      part.state === 'approved_with_edits' ||
      part.state === 'denied'
    ) {
      // A decision-layout receipt owns its durable decision time. Row layout keeps the host time.
      if (layout === 'decision' || part.receipt === undefined) return undefined;
      const decided = new Date(part.receipt.decidedAt);
      return Number.isNaN(decided.getTime())
        ? undefined
        : settledMoment(decided, decided.toISOString());
    }
    const expiresAt = part.action.expiresAt;
    if (expiresAt === undefined) return undefined;
    const passed = Date.parse(expiresAt) <= now;
    if (part.state !== 'expired' && !(part.state === 'pending' && passed)) return undefined;
    return settledMoment(new Date(expiresAt), expiresAt);
  });

  function resolveApproval(resolution: ApprovalResolution): void {
    if (!canResolve || part.resolutionInFlight) return;
    onApprovalResolve?.(part.toolCallId, resolution);
  }

  function handleKeydown(event: KeyboardEvent): void {
    // An armed irreversible press owns Escape: it reverts the arm and marks the key handled, so the
    // approval itself is not cancelled by the same keystroke.
    if (event.key !== 'Escape' || !canResolve || part.resolutionInFlight || event.defaultPrevented)
      return;
    event.preventDefault();
    resolveApproval({ decision: 'cancel', remember: false });
  }
</script>

<ApprovalCard
  {...cardProps}
  bind:reason
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
