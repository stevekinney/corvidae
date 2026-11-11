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

import type { ApprovalDecisionSurface } from './types';

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
  /**
   * COR-2292 — where the person decided, when the caller said: `chat` or `reviews`. Absent when it
   * is unknown, which every row written before the field existed is.
   */
  readonly decisionSurface?: ApprovalDecisionSurface;
}

/**
 * COR-2292 — whether `value` is a decision surface, exactly: the check is case-sensitive, so
 * `Reviews` is not one.
 */
export function isApprovalDecisionSurface(value: unknown): value is ApprovalDecisionSurface {
  return value === 'chat' || value === 'reviews';
}

/**
 * COR-2292 — the surface a resolution records: the caller's, for a tool approval only. A human
 * wait's answer keeps none, whatever its caller said.
 */
export function decisionSurfaceOf(
  review: { readonly kind: 'tool-approval' | 'human-wait' },
  input: { readonly decisionSurface?: ApprovalDecisionSurface },
): ApprovalDecisionSurface | undefined {
  return review.kind === 'tool-approval' ? input.decisionSurface : undefined;
}

/**
 * COR-2292 — the record a decision writes over a row that already holds one. An outcome row is
 * decided once, so the first decision's surface stands, and so does its absence: a later write of
 * the same decision from another surface neither replaces a known surface nor fills in an unknown
 * one. A row that holds no record (`held` is not an object) takes `record` as it is.
 */
export function withFirstDecisionSurface(
  record: ApprovalDecisionRecord,
  held: JSONValue | undefined,
): ApprovalDecisionRecord {
  if (typeof held !== 'object' || held === null || Array.isArray(held)) return record;
  const { decisionSurface: _offered, ...rest } = record;
  const first = Object.hasOwn(held, 'decisionSurface') ? held['decisionSurface'] : undefined;
  return isApprovalDecisionSurface(first) ? { ...rest, decisionSurface: first } : rest;
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
      ...(record.decisionSurface === undefined ? {} : { decisionSurface: record.decisionSurface }),
    },
  };
}
