/**
 * Pending reviews as AG-UI interrupts, and the payload that answers them.
 *
 * An interrupt carries the review's own id, verbatim, so the interrupt a client
 * shows and the item `bureau.reviews.*` lists are one identifier and a resume
 * entry's `interruptId` is what `reviews.resolve` takes. It carries no tool
 * arguments, no approval token, and no binding: the arguments were streamed as
 * `TOOL_CALL_ARGS`, and resolving goes through the id.
 *
 * @module ag-ui-interrupts
 */

import type { Interrupt, ResumeEntry } from '@ag-ui/core';

import type { PendingReview } from '../types.ts';
import { projectReview } from './bureau-reviews-operations.ts';
import { BUREAU_METADATA_KEY } from './ag-ui-vocabulary.ts';

/**
 * The JSON Schema of the payload that answers an interrupt, the same for both
 * review kinds. `arguments` applies to a tool approval that is approved and
 * overrides the call's arguments; `answer` applies to a human wait that is
 * approved and is delivered as the signal's payload; `reason` is required, and
 * must hold a character other than whitespace, to `reject`, which is the rule the
 * resume boundary enforces.
 */
export const RESUME_PAYLOAD_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision: { enum: ['approve', 'deny', 'reject'] },
    reason: { type: 'string' },
    arguments: {},
    answer: {},
  },
  required: ['decision'],
  additionalProperties: false,
  anyOf: [
    { properties: { decision: { enum: ['approve', 'deny'] } } },
    {
      properties: { decision: { const: 'reject' }, reason: { type: 'string', pattern: '\\S' } },
      required: ['reason'],
    },
  ],
};

/** The answer to one interrupt, as the `payload` of a `resolved` resume entry. */
export type AgUiResumePayload = {
  decision: 'approve' | 'deny' | 'reject';
  reason?: string;
  arguments?: unknown;
  answer?: unknown;
};

/**
 * The round of the tool approval a resume entry answers: the `round` the client read from the
 * interrupt's metadata, sent back under the same key in the entry's own `metadata` (COR-1714). A
 * re-gated approval keeps its id and advances its round, so the round is what says which request
 * the answer was made on. `undefined` when the entry names none, and its answer is not fenced;
 * `null` when what it names is not a round.
 */
export function roundOfEntry(entry: ResumeEntry): number | null | undefined {
  const fields: unknown = entry.metadata?.[BUREAU_METADATA_KEY];
  if (fields === undefined) return undefined;
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null;
  const round: unknown = (fields as Record<string, unknown>)['round'];
  if (round === undefined) return undefined;
  return typeof round === 'number' && Number.isSafeInteger(round) && round >= 0 ? round : null;
}

/** One pending review as the interrupt that asks for its answer. */
export function toInterrupt(review: PendingReview): Interrupt {
  const projected = projectReview({ ...review, status: 'pending' });
  if (review.kind === 'human-wait') {
    return {
      id: review.id,
      reason: 'human-wait',
      ...(review.prompt === undefined ? {} : { message: review.prompt }),
      responseSchema: RESUME_PAYLOAD_SCHEMA,
      metadata: {
        [BUREAU_METADATA_KEY]: {
          kind: 'human-wait',
          runId: review.runId,
          sessionId: review.sessionId,
          signalName: review.signalName,
        },
      },
    };
  }
  const action = review.approval.action;
  const message = action.message ?? review.approval.reason;
  const approvalAction = action.type === 'approval' ? action : undefined;
  const wire = projected.kind === 'tool-approval' ? projected.approval : undefined;
  return {
    id: review.id,
    reason: 'tool-approval',
    toolCallId: review.approval.callId,
    ...(message === undefined ? {} : { message }),
    ...(approvalAction?.expiresAt === undefined ? {} : { expiresAt: approvalAction.expiresAt }),
    responseSchema: RESUME_PAYLOAD_SCHEMA,
    metadata: {
      [BUREAU_METADATA_KEY]: {
        kind: 'tool-approval',
        runId: review.runId,
        sessionId: review.sessionId,
        round: review.round,
        toolName: review.approval.toolName,
        ...(wire?.action.type === 'approval'
          ? { risk: wire.action.risk, operation: wire.action.operation }
          : {}),
      },
    },
  };
}

/**
 * The key that identifies a set of interrupts in the command ledger: the sorted
 * `[id, round]` pairs, serialized as JSON. A join with delimiters would not be
 * injective (an id may contain the delimiter), and the key is persisted, so its
 * encoding is part of the stored contract. A human wait has no rounds, so its
 * round is 0.
 */
export function interruptKey(reviews: ReadonlyArray<PendingReview>): string {
  const pairs = reviews
    .map((review): [string, number] => [
      review.id,
      review.kind === 'tool-approval' ? review.round : 0,
    ])
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify(pairs);
}
