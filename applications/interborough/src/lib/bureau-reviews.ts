/**
 * The Bureau's review operations as the browser calls them: `bureau.reviews.list`, `.get` and
 * `.resolve`. A review is what a run is waiting on a person for, either a tool approval or a
 * question (a human wait). The schemas restate the wire shapes in
 * `packages/bureau/src/http/bureau-reviews-operations.ts`, as `bureau-client.ts` restates a
 * context's.
 */
import { HttpClientError } from '@lostgradient/weft';
import { z } from 'zod';

import { callBureau } from './bureau-client.ts';

const reviewCommon = {
  id: z.string(),
  runId: z.string(),
  agentName: z.string().optional(),
  /** Epoch milliseconds the review was requested. */
  requestedAt: z.number(),
  ageMilliseconds: z.number(),
  status: z.enum([
    'pending',
    'approved',
    'denied',
    'rejected',
    'expired',
    'revoked',
    'canceled',
    'superseded',
  ]),
};

const toolActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), message: z.string().optional() }),
  z.object({
    type: z.literal('approval'),
    message: z.string().optional(),
    risk: z.enum(['low', 'medium', 'high']),
    // What the policy evaluated, as the server declares it: a command, a patch, and the files
    // either touches. Each is there only for the kinds that carry it.
    operation: z
      .object({
        kind: z.string(),
        command: z.string().optional(),
        diff: z.string().optional(),
        filesTouched: z.array(z.string()).optional(),
      })
      .loose(),
    expiresAt: z.string().optional(),
  }),
]);

/** One review, as `bureau.reviews.list` and `.get` show it. */
export const bureauReviewSchema = z.discriminatedUnion('kind', [
  z.object({
    ...reviewCommon,
    kind: z.literal('tool-approval'),
    sessionId: z.string(),
    round: z.number(),
    approval: z.object({
      callId: z.string(),
      toolName: z.string(),
      arguments: z.unknown(),
      reason: z.string().optional(),
      action: toolActionSchema,
      policyPauseTier: z.enum(['capability', 'registry', 'tool']).optional(),
    }),
  }),
  z.object({
    ...reviewCommon,
    kind: z.literal('human-wait'),
    /** Absent for the park of a run that has no session; its `runId` addresses it. */
    sessionId: z.string().optional(),
    signalName: z.string(),
    prompt: z.string().optional(),
  }),
]);

/** A review waiting on a person: either a tool approval or a human wait. */
export type BureauReview = z.infer<typeof bureauReviewSchema>;
/** A review that asks whether a gated tool call may run. */
export type BureauToolApproval = Extract<BureauReview, { kind: 'tool-approval' }>;
/** A review that asks a person for the input a run is parked on. */
export type BureauHumanWait = Extract<BureauReview, { kind: 'human-wait' }>;

type Options = { readonly signal?: AbortSignal };

/** The reviews waiting for a decision, from the caller's own runs (`bureau.reviews.list`). */
export async function listBureauReviews(options?: Options): Promise<readonly BureauReview[]> {
  const body = z
    .object({ reviews: z.array(bureauReviewSchema) })
    .parse(await callBureau('bureau.reviews.list', {}, options));
  return body.reviews;
}

/** One review by its id, pending or not. One the caller may not see is a not-found fault. */
export async function getBureauReview(id: string, options?: Options): Promise<BureauReview> {
  return bureauReviewSchema.parse(await callBureau('bureau.reviews.get', { id }, options));
}

/** The decisions a person can give a review: approve it, deny it, or reject it. */
export const reviewDecisionSchema = z.enum(['approve', 'deny', 'reject']);

/** One decision a person can give a review. */
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

const resolveAnswerSchema = z.object({
  id: z.string(),
  kind: z.enum(['tool-approval', 'human-wait']),
  decision: reviewDecisionSchema,
  /** `superseded` means the approval was gated again and stays pending, so the tool did not run. */
  receipt: z.enum(['applied', 'rejected', 'superseded']),
  feedback: z.string().optional(),
});

/**
 * What the Bureau answers for a decision: the review's identifier and kind, the decision, and
 * whether it was applied, rejected, or superseded.
 */
export type ReviewResolution = z.infer<typeof resolveAnswerSchema>;

/**
 * The token a `Conflict`'s reason begins with when a decision took effect (the tool ran or was
 * refused) and only its write into the session's conversation failed. It is not a resolver that
 * lost (`bureau.reviews.resolve`'s description).
 */
export const APPROVAL_OUTCOME_NOT_WRITTEN = 'APPROVAL_OUTCOME_NOT_WRITTEN';

/** Whether a fault says the decision took effect and only its outcome was not written. */
export function isApprovalOutcomeNotWritten(error: unknown): boolean {
  if (!(error instanceof HttpClientError)) return false;
  const reason: unknown = error.data?.['reason'];
  return typeof reason === 'string' && reason.startsWith(`${APPROVAL_OUTCOME_NOT_WRITTEN}:`);
}

/**
 * The token a `Conflict`'s reason begins with when the review had moved to another round than the
 * one sent: a re-gated approval keeps its id, so the decision was made on a request that is no longer
 * the one pending, and nothing was decided (`bureau.reviews.resolve`'s description).
 */
export const REVIEW_ROUND_CHANGED = 'REVIEW_ROUND_CHANGED';

/** Whether a fault says the review changed while it was read, so the decision was not made. */
export function isReviewRoundChanged(error: unknown): boolean {
  if (!(error instanceof HttpClientError)) return false;
  const reason: unknown = error.data?.['reason'];
  return typeof reason === 'string' && reason.startsWith(`${REVIEW_ROUND_CHANGED}:`);
}

/**
 * Approves, denies, or rejects a review (`bureau.reviews.resolve`). A rejection needs its reason.
 * `round` is the round of the tool approval the person was shown, which fences the decision on it.
 */
export async function resolveBureauReview(
  input: {
    readonly id: string;
    readonly decision: ReviewDecision;
    readonly reason?: string;
    readonly round?: number;
  },
  options?: Options,
): Promise<ReviewResolution> {
  return resolveAnswerSchema.parse(await callBureau('bureau.reviews.resolve', input, options));
}
