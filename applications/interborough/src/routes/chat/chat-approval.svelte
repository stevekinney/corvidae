<script lang="ts">
  /**
   * One tool approval under its call in the transcript (COR-2016): Cinder's shared approval row.
   * Waiting, it asks the question with the tool, where it came from and the input, takes a note and
   * Allow for the rest of this chat, and offers Deny and Approve; while Interborough cannot be
   * reached both are off, with the reason written above them. Decided, it collapses to what was
   * asked and what became of it: "Approved by you · 10:33 AM", or "Approved by you in Reviews ·
   * 10:46 AM" when the decision was made on another page while this one was open, with the note a
   * refusal carried. The row is a group named by its question and focusable by script alone, so the
   * page can bring the person to it on opening without answering it.
   */
  import { ApprovalCard, type ApprovalResolution } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy.ts';
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
    ? 'pending'
    : decision.outcome === 'approved'
      ? 'approved'
      : 'denied'}
  {...decision === undefined
    ? {
        rememberScope: CHAT_COPY.approval.rememberScope,
        ...(unreachable ? { disabledReason: CHAT_COPY.approval.unreachable } : {}),
        ...(resolving === undefined ? {} : { resolving }),
        onResolve,
      }
    : {
        decidedBy: decidedByLabel(decision, context.owner),
        decidedAt: decision.decidedAt,
        ...(place === undefined ? {} : { decidedIn: place }),
        ...(decision.reason === undefined ? {} : { decisionNote: decision.reason }),
      }}
  {...decision === undefined ? { 'data-approval-decision': true, tabindex: -1 } : {}}
/>
