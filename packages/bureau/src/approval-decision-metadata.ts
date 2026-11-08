/**
 * Who decided a tool approval, and when (COR-2016).
 *
 * Resolving a tool approval replaces the call's waiting row in the session's conversation with the
 * outcome, and the outcome says what the call returned or that it was refused, but not that a
 * person decided it, who, or when. A page that opens the chat afterwards, or that was open when
 * the decision was made somewhere else, can only say "Approved by you · 10:33 AM" if the row says
 * so. The outcome's row carries this under {@link APPROVAL_DECISION_METADATA_KEY}, in the same
 * commit as the outcome, so the two never disagree.
 *
 * @module approval-decision-metadata
 */

import type { JSONValue } from 'armorer/protocol';

/** Where a `tool-result` row keeps how its approval was decided: an {@link ApprovalDecisionRecord}. */
export const APPROVAL_DECISION_METADATA_KEY = 'approvalDecision';

/** How a tool approval was decided, as written on the call's outcome row. */
export interface ApprovalDecisionRecord {
  /** What was decided. A `reject` is a `deny` that was given a reason. */
  readonly decision: 'approve' | 'deny' | 'reject';
  /** The principal that decided, as `bureau.reviews.resolve` recorded it. */
  readonly decidedBy: string;
  /** When it was decided, as an ISO 8601 time on the Bureau's clock. */
  readonly decidedAt: string;
  /** The note the decider left with the decision, which the agent reads as the reason for a refusal. */
  readonly reason?: string;
  /**
   * The sentence the tool asked with ("Refund order 4471 for $42.00"), which the outcome replaces
   * along with the waiting row. Absent when the tool wrote none.
   */
  readonly asked?: string;
}

/** The record as the JSON an outcome row's metadata holds. */
export function approvalDecisionMetadata(
  record: ApprovalDecisionRecord,
): Record<string, JSONValue> {
  return {
    [APPROVAL_DECISION_METADATA_KEY]: {
      decision: record.decision,
      decidedBy: record.decidedBy,
      decidedAt: record.decidedAt,
      ...(record.reason === undefined || record.reason === '' ? {} : { reason: record.reason }),
      ...(record.asked === undefined || record.asked === '' ? {} : { asked: record.asked }),
    },
  };
}
