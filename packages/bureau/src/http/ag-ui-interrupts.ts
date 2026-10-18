/**
 * Pending reviews as AG-UI interrupts, and the payload that answers them.
 *
 * An interrupt carries the review's own id, verbatim, so the interrupt a client
 * shows and the item `bureau.reviews.*` lists are one identifier and a resume
 * entry's `interruptId` is what `resolveReview` takes. It carries no tool
 * arguments, no approval token, and no binding: the arguments were streamed as
 * `TOOL_CALL_ARGS`, and resolving goes through the id.
 *
 * @module ag-ui-interrupts
 */

import type { Interrupt } from '@ag-ui/core';

import type { PendingReview } from '../types.ts';
import { projectReview } from './bureau-reviews-operations.ts';
import { BUREAU_METADATA_KEY } from './ag-ui-vocabulary.ts';

/**
 * The JSON Schema of the payload that answers an interrupt, the same for both
 * review kinds. `arguments` applies to a tool approval that is approved and
 * overrides the call's arguments; `answer` applies to a human wait that is
 * approved and is delivered as the signal's payload; `reason` is required, and
 * non-blank, to `reject`.
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
};

/** The answer to one interrupt, as the `payload` of a `resolved` resume entry. */
export type AgUiResumePayload = {
  decision: 'approve' | 'deny' | 'reject';
  reason?: string;
  arguments?: unknown;
  answer?: unknown;
};

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

/** The ids a resume must cover for the reviews pending on `runId`, as `id@round`, sorted. */
export function interruptKey(reviews: ReadonlyArray<PendingReview>): string {
  return reviews
    .map((review) => `${review.id}@${review.kind === 'tool-approval' ? review.round : 0}`)
    .toSorted()
    .join(',');
}
