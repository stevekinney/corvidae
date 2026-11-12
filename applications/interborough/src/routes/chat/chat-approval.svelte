<script lang="ts">
  /**
   * One tool approval under its call in the transcript (COR-2016): Cinder's shared approval row.
   * Waiting, it asks the question with the tool, where it came from and the input, takes a note and
   * Allow for the rest of this chat, and offers Deny and Approve; while Interborough cannot be
   * reached both are off, with the reason written above them. Decided, it collapses to what was
   * asked and what became of it: "Approved by you, 10:33 AM", or "Approved by you in Reviews,
   * 10:46 AM" when the decision was made on another page while this one was open, with the note a
   * refusal carried. The row is a group named by its question and focusable by script alone, so the
   * page can bring the person to it on opening without answering it. A held approval of an agent
   * whose plugin is disabled reads Unavailable with its reason and no buttons; while no provider is
   * connected a waiting one stays answerable, and a muted line under it says the run continues once
   * a provider is connected.
   */
  import { ApprovalCard, type ApprovalResolution } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { approvalQuestion } from '../../lib/tool-text.ts';
  import { decidedByLabel, decidedPlace, type DecisionContext } from './approval-decision-words.ts';
  import type { ToolCallEntry } from './tool-activity.ts';

  interface ChatApprovalProps {
    /** A name that is unique on the page. */
    id: string;
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
    /** Whether Interborough cannot be reached, which turns Deny and Approve off with the reason. */
    unreachable: boolean;
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
    /** Sends the person's decision, the note and the grant for the rest of the chat included. */
    onResolve: (resolution: ApprovalResolution) => void;
  }

  let {
    id,
    entry,
    question,
    source,
    requestedAt,
    context,
    unreachable,
    unavailableReason,
    providerNote,
    alwaysAsks,
    resolving,
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
</script>

<ApprovalCard
  {id}
  layout="row"
  headingLevel={4}
  question={decision === undefined ? question : decidedQuestion}
  tool={{
    name: entry.name,
    ...(entry.title === undefined ? {} : { label: entry.title }),
    risk,
    irreversible: entry.tier === 'dangerous',
  }}
  {source}
  {...requestedAt === undefined ? {} : { requestedAt }}
  operation={{ kind: 'other', argsPreview: entry.arguments }}
  policyVersion={id}
  idempotencyKey={entry.callId}
  state={decision === undefined
    ? unavailableReason === undefined
      ? 'pending'
      : 'unavailable'
    : decision.outcome === 'approved'
      ? 'approved'
      : 'denied'}
  {...decision === undefined
    ? unavailableReason === undefined
      ? {
          ...(alwaysAsks === true ? {} : { rememberScope: CHAT_COPY.approval.rememberScope }),
          ...(unreachable ? { disabledReason: CHAT_COPY.approval.unreachable } : {}),
          ...(resolving === undefined ? {} : { resolving }),
          onResolve,
        }
      : { unavailableReason }
    : {
        decidedBy: decidedByLabel(decision, context.owner),
        decidedAt: decision.decidedAt,
        ...(place === undefined ? {} : { decidedIn: place }),
        ...(decision.reason === undefined ? {} : { decisionNote: decision.reason }),
      }}
  {...decision === undefined ? { 'data-approval-decision': true, tabindex: -1 } : {}}
/>
{#if decision === undefined && unavailableReason === undefined && providerNote !== undefined}
  <p class="weft-chat-approval__provider-note">{providerNote}</p>
{/if}
