/**
 * How a decided tool approval is worded in the transcript (COR-2016, design rows 18i, 18j, 18g):
 * who decided, where when it was not here, and when. The Bureau records who and when on the call's
 * outcome row (`tool-activity.ts`, `recordedDecision`); where is what this page knows, because it
 * was showing the approval as waiting when someone decided it somewhere else.
 */
import { CHAT_COPY } from '../../app/copy.ts';
import { clockTime, viewerTimeZone } from '../../lib/format/clock.ts';
import type { ApprovalDecision, ToolCallEntry } from './tool-activity.ts';

/** What the words of a decided approval depend on besides the decision itself. */
export type DecisionContext = {
  /** The chat's owner: a decision this principal made reads as "you". */
  readonly owner?: string | null | undefined;
  /** The calls this page watched go from waiting to decided away from the chat. */
  readonly elsewhere?: ReadonlySet<string> | undefined;
  /** The zone times are written in. Defaults to the viewer's. */
  readonly zone?: string | undefined;
};

/** Who decided: "you" when it was the chat's own person, otherwise the principal as recorded. */
export function decidedByLabel(
  decision: ApprovalDecision,
  owner: string | null | undefined,
): string {
  return owner !== null && owner !== undefined && decision.decidedBy === owner
    ? CHAT_COPY.tools.decided.you
    : decision.decidedBy;
}

/** Where the call's approval was decided when that was not the chat, such as "Reviews". */
export function decidedPlace(entry: ToolCallEntry, context: DecisionContext): string | undefined {
  return context.elsewhere?.has(entry.callId) === true
    ? CHAT_COPY.tools.decided.elsewhere
    : undefined;
}

/** The rail's words for a decided call, such as "Approved by you in Reviews 10:46 AM · $42.00 refunded". */
export function decidedLine(entry: ToolCallEntry, context: DecisionContext): string | undefined {
  const decision = entry.decision;
  if (decision === undefined) return undefined;
  return CHAT_COPY.tools.decided.line(
    decision.outcome === 'approved'
      ? CHAT_COPY.tools.decided.approved
      : CHAT_COPY.tools.decided.denied,
    decidedByLabel(decision, context.owner),
    decidedPlace(entry, context),
    clockTime(decision.decidedAt, context.zone ?? viewerTimeZone()),
    // What a refusal came to is not known: only what an approved call returned is said.
    decision.outcome === 'approved' ? entry.summary : '',
  );
}
