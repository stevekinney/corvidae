<script lang="ts">
  /**
   * One tool approval under its call in the transcript (COR-2016): Cinder's explicit decision
   * surface (`layout="decision"`, COR-2282), the one Chat draws for a single approval. Waiting, it
   * asks the question with the tool and the input, says why when the approval does, takes a note and
   * Allow for the rest of this chat, and offers Deny and Approve; while Interborough cannot be
   * reached both are off, with the reason written above them. Decided, it folds to one line (board
   * row A4): the status, the action, "by you" and the time, then Details, or "by Priya Raman in
   * Reviews" when the decision was made in Reviews, with Reviews a link to it, and the note a
   * refusal carried behind Details. The row is a group named by its question and focusable by script alone, so the
   * page can bring the person to it on opening without answering it. A held approval of an agent
   * whose plugin is disabled reads Unavailable with its reason and no buttons; while no provider is
   * connected a waiting one stays answerable, and a muted line under it says the run continues once
   * a provider is connected.
   */
  import {
    ApprovalCard,
    type ApprovalFailure,
    type ApprovalOperation,
    type ApprovalResolution,
  } from '@lostgradient/cinder';

  import { CHAT_APPROVAL_FOR_ATTRIBUTE } from '@lostgradient/chat';

  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { approvalQuestion } from '../../lib/tool-text.ts';
  import { decidedByLabel, decidedPlace, type DecisionContext } from './approval-decision-words.ts';
  import type { ToolCallEntry } from './tool-activity.ts';

  interface ChatApprovalProps {
    'data-changes'?: boolean;
    /** A name that is unique on the page. */
    id: string;
    /**
     * `decision` (default) for an approval on its own under its call; `row` for a compact row of
     * the turn's ApprovalGroup, when two or more wait together (board row A3).
     */
    layout?: 'decision' | 'row';
    /** The call the approval is for. Its `decision` says it was decided, and how. */
    entry: ToolCallEntry;
    /** What a waiting approval asks, ending in a question mark. A decided one reads its own. */
    question: string;
    /** Who asked: the agent's name as a person reads it. */
    source: string;
    /** When the approval was asked, in epoch milliseconds, when the Bureau has said. */
    requestedAt?: number | undefined;
    /** Who the person is to this chat and where decisions were made, for a decided approval. */
    context: DecisionContext;
    operation?: ApprovalOperation | undefined;
    /** Whether the operation cannot be undone; without it, a dangerous tool's call is taken as such. */
    irreversible?: boolean | undefined;
    /**
     * The id of the message that asks for the approval. A waiting card carries it as
     * `data-chat-approval-for`, so Chat's arrival scroll, visibility check and reminder find the
     * card this page draws outside Chat's message rows (COR-2440 AC5).
     */
    approvalMessageId?: string | undefined;
    /** What approving does, in one sentence, as the approval declares it (COR-2438). */
    consequence?: string | undefined;
    /** Why the agent wants to do it, offered as a disclosure (COR-2438). */
    why?: string | undefined;
    /**
     * Where a decision made in Reviews can be read: the receipt writes "in Reviews" as a link there
     * (COR-2282 A5).
     */
    decidedInHref?: string | undefined;
    policyVersion?: string | undefined;
    idempotencyKey?: string | undefined;
    expiresAt?: string | undefined;
    actionLabel?: string | undefined;
    failure?: ApprovalFailure | undefined;
    /** Whether Interborough cannot be reached, which turns Deny and Approve off with the reason. */
    unreachable: boolean;
    disabledReason?: string | undefined;
    /**
     * Why nobody can answer it now, when the agent that asked is held back by a disabled plugin:
     * the approval reads Unavailable with this under it and offers no decision.
     */
    unavailableReason?: string | undefined;
    /** Said under a waiting approval while no provider is connected, such as "Tool runner continues once a provider is connected.". */
    providerNote?: string | undefined;
    /**
     * Whether the tool is set to Always, which asks on every call: "Allow for the rest of this chat"
     * is then not offered, because the grant would change nothing (decision 86).
     */
    alwaysAsks?: boolean | undefined;
    /** The answer on its way, which holds both buttons until it lands. */
    resolving?: 'approve' | 'deny' | undefined;
    onAskAgain?: (() => void) | undefined;
    /** Sends the person's decision, the note and the grant for the rest of the chat included. */
    onResolve: (resolution: ApprovalResolution) => void;
  }

  let {
    'data-changes': dataChanges = false,
    id,
    layout = 'decision',
    entry,
    question,
    source,
    requestedAt,
    context,
    operation,
    irreversible,
    approvalMessageId,
    consequence,
    why,
    decidedInHref,
    policyVersion,
    idempotencyKey,
    expiresAt,
    actionLabel,
    failure,
    unreachable,
    disabledReason,
    unavailableReason,
    providerNote,
    alwaysAsks,
    resolving,
    onAskAgain,
    onResolve,
  }: ChatApprovalProps = $props();

  const decision = $derived(entry.decision);
  const risk = $derived(
    entry.tier === 'read-only' ? 'low' : entry.tier === 'dangerous' ? 'high' : 'medium',
  );
  const place = $derived(decidedPlace(entry, context));
  const decidedQuestion = $derived(
    approvalQuestion({
      toolName: entry.name,
      arguments: entry.arguments,
      summary: decision?.asked,
    }),
  );
  const expired = $derived(
    entry.state === 'expired' ||
      (entry.approvalExpiresAt !== undefined && Date.now() >= entry.approvalExpiresAt) ||
      (expiresAt !== undefined &&
        Number.isFinite(Date.parse(expiresAt)) &&
        Date.parse(expiresAt) <= Date.now()),
  );
  // The moment the approval lapsed, as the host knows it: the action's own deadline, else the
  // entry's.
  const lapsedAt = $derived(
    expiresAt !== undefined && Number.isFinite(Date.parse(expiresAt))
      ? expiresAt
      : entry.approvalExpiresAt === undefined
        ? undefined
        : new Date(entry.approvalExpiresAt).toISOString(),
  );
  // An expired card writes when it lapsed in its own status line (board row A4), so it is given the
  // moment it lapsed as its deadline.
  const cardDeadline = $derived(expired ? lapsedAt : expiresAt);
</script>

<ApprovalCard
  {...dataChanges ? { 'data-changes': true } : {}}
  {id}
  {layout}
  headingLevel={4}
  question={decision === undefined ? question : decidedQuestion}
  tool={{
    name: entry.name,
    ...(entry.title === undefined ? {} : { label: entry.title }),
    risk,
    ...(irreversible === undefined
      ? { irreversible: entry.tier === 'dangerous' }
      : { irreversible }),
  }}
  {source}
  {...requestedAt === undefined ? {} : { requestedAt }}
  operation={operation ?? { kind: 'other', argsPreview: entry.arguments }}
  policyVersion={policyVersion ?? id}
  idempotencyKey={idempotencyKey ?? entry.callId}
  {...cardDeadline === undefined ? {} : { expiresAt: cardDeadline }}
  {...actionLabel === undefined ? {} : { actionLabel }}
  {...consequence === undefined ? {} : { consequence }}
  {...why === undefined ? {} : { why }}
  {...failure === undefined ? {} : { failure }}
  {...onAskAgain === undefined ? {} : { onAskAgain }}
  state={decision === undefined
    ? unavailableReason === undefined
      ? expired
        ? 'expired'
        : 'pending'
      : 'unavailable'
    : decision.outcome === 'approved'
      ? 'approved'
      : 'denied'}
  {...decision === undefined
    ? unavailableReason === undefined
      ? {
          ...(alwaysAsks === true ? {} : { rememberScope: CHAT_COPY.approval.rememberScope }),
          ...(disabledReason === undefined
            ? unreachable
              ? { disabledReason: CHAT_COPY.approval.unreachable }
              : {}
            : { disabledReason }),
          ...(resolving === undefined ? {} : { resolving }),
          onResolve,
        }
      : { unavailableReason }
    : {
        decidedBy: decidedByLabel(decision, context.owner),
        decidedAt: decision.decidedAt,
        ...(place === undefined
          ? {}
          : { decidedIn: place, ...(decidedInHref === undefined ? {} : { decidedInHref }) }),
        ...(decision.reason === undefined ? {} : { decisionNote: decision.reason }),
      }}
  {...decision === undefined
    ? {
        'data-approval-decision': true,
        'data-cinder-tool-approval': true,
        'data-cinder-tool-approval-call-id': entry.railId ?? entry.callId,
        ...(approvalMessageId === undefined
          ? {}
          : { [CHAT_APPROVAL_FOR_ATTRIBUTE]: approvalMessageId }),
        tabindex: -1,
      }
    : {}}
/>
<!-- When it was decided, or when it lapsed, is a piece of the card's own status line (board row
     A4), not a line under the card. -->
{#if decision === undefined && unavailableReason === undefined && providerNote !== undefined}
  <p class="weft-chat-approval__provider-note">{providerNote}</p>
{/if}
