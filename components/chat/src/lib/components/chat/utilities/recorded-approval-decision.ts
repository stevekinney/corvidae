/**
 * A decision on a tool approval as the host recorded it on the call's outcome row (COR-2282 A5,
 * COR-2292). Bureau writes it under the `approvalDecision` metadata key of the `tool-result` row in
 * the same commit as the outcome, so a chat opened afterwards, or open while the decision was made
 * in Reviews, can still say who decided, when, and where.
 */
import type { ApprovalState } from '@lostgradient/cinder';

import type { Message } from '../conversation-model.ts';
import type { ToolApprovalAction, ToolApprovalReceiptRecord } from './types.ts';

/** Where a `tool-result` row keeps how its approval was decided. */
const APPROVAL_DECISION_METADATA_KEY = 'approvalDecision';

/** The places a decision can be recorded as made. */
type ApprovalDecisionSurface = 'chat' | 'reviews';

/** A decision read from a result row, checked field by field. */
type RecordedApprovalDecision = {
  readonly outcome: 'approved' | 'denied';
  /** The principal that decided, as recorded. */
  readonly decidedBy: string;
  /** When, in epoch milliseconds. */
  readonly decidedAt: number;
  readonly reason?: string;
  /** The sentence the approval asked with, which the outcome replaced. */
  readonly asked?: string;
  readonly decisionSurface?: ApprovalDecisionSurface;
};

/** Reads an own property only: the metadata is the host's data, not a prototype's. */
function own(record: object, key: string): unknown {
  return Object.hasOwn(record, key) ? Reflect.get(record, key) : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The decision a row's metadata records, or `undefined` when it records none that reads whole. */
function readRecordedApprovalDecision(metadata: unknown): RecordedApprovalDecision | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const value = own(metadata, APPROVAL_DECISION_METADATA_KEY);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const decision = own(value, 'decision');
  const decidedBy = nonEmpty(own(value, 'decidedBy'));
  const decidedAtText = own(value, 'decidedAt');
  const decidedAt = typeof decidedAtText === 'string' ? Date.parse(decidedAtText) : Number.NaN;
  if (
    (decision !== 'approve' && decision !== 'deny' && decision !== 'reject') ||
    decidedBy === undefined ||
    !Number.isFinite(decidedAt)
  ) {
    return undefined;
  }
  const reason = nonEmpty(own(value, 'reason'));
  const asked = nonEmpty(own(value, 'asked'));
  const surface = own(value, 'decisionSurface');
  return {
    outcome: decision === 'approve' ? 'approved' : 'denied',
    decidedBy,
    decidedAt,
    ...(reason === undefined ? {} : { reason }),
    ...(asked === undefined ? {} : { asked }),
    // Only the two surfaces Bureau records count; anything else reads as unknown.
    ...(surface === 'chat' || surface === 'reviews' ? { decisionSurface: surface } : {}),
  };
}

/** What the receipt needs from the host to say who and where. */
export type RecordedReceiptContext = {
  /** The tool's name for a call, from its call row. */
  readonly toolName: (toolCallId: string) => string | undefined;
  /** The reader's own principal: a decision it made reads as `you`. */
  readonly currentPrincipal?: string | undefined;
  /** The word for the reader, `you`. */
  readonly you: string;
  /** The word for a decision made in Reviews, such as `Reviews`. */
  readonly reviews: string;
  /** Where the Reviews decision can be read, for the receipt's link. */
  readonly reviewsHref?: ((toolCallId: string) => string | undefined) | undefined;
};

/**
 * The receipt of every approval the conversation records as decided, keyed by call. A decision
 * made in Reviews says so, with a link when the host gives one; one made in a chat names no place.
 * A row still asking for approval has not been decided, whatever its metadata says.
 */
export function recordedApprovalReceipts(
  messages: readonly Message[],
  context: RecordedReceiptContext,
): Map<string, ToolApprovalReceiptRecord> {
  const receipts = new Map<string, ToolApprovalReceiptRecord>();
  for (const message of messages) {
    const result = message.toolResult;
    if (message.role !== 'tool-result' || result === undefined) continue;
    if (result.outcome === 'action_required') continue;
    const decision = readRecordedApprovalDecision(message.metadata);
    if (decision === undefined) continue;
    const toolCallId = result.callId;
    const toolName = context.toolName(toolCallId) ?? toolCallId;
    const href =
      decision.decisionSurface === 'reviews' ? context.reviewsHref?.(toolCallId) : undefined;
    const action: ToolApprovalAction = {
      type: 'approval',
      ...(decision.asked === undefined ? {} : { message: decision.asked }),
      // What the action was is gone with the waiting row; the receipt says what was decided.
      risk: 'medium',
      operation: { kind: 'other' },
      policyVersion: 'recorded',
      idempotencyKey: toolCallId,
    };
    const state: ApprovalState = decision.outcome;
    receipts.set(toolCallId, {
      toolName,
      action,
      state,
      receipt: {
        decidedAt: decision.decidedAt,
        decidedBy:
          context.currentPrincipal !== undefined && decision.decidedBy === context.currentPrincipal
            ? context.you
            : decision.decidedBy,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        ...(decision.decisionSurface === 'reviews' ? { decidedIn: context.reviews } : {}),
        ...(href === undefined ? {} : { decidedInHref: href }),
      },
    });
  }
  return receipts;
}
