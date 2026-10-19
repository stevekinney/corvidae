/**
 * The Bureau's review operations as the browser calls them: `bureau.reviews.list`, `.get` and
 * `.resolve`. A review is what a run is waiting on a person for, either a tool approval or a
 * question (a human wait). The schemas restate the wire shapes in
 * `packages/bureau/src/http/bureau-reviews-operations.ts`, as `bureau-client.ts` restates a
 * context's.
 */
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
    operation: z.object({ kind: z.string() }).loose(),
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

export type BureauReview = z.infer<typeof bureauReviewSchema>;
export type BureauToolApproval = Extract<BureauReview, { kind: 'tool-approval' }>;
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

export const reviewDecisionSchema = z.enum(['approve', 'deny', 'reject']);

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

const resolveAnswerSchema = z.object({
  id: z.string(),
  kind: z.enum(['tool-approval', 'human-wait']),
  decision: reviewDecisionSchema,
  /** `superseded` means the approval was gated again and stays pending, so the tool did not run. */
  receipt: z.enum(['applied', 'rejected', 'superseded']),
  feedback: z.string().optional(),
});

export type ReviewResolution = z.infer<typeof resolveAnswerSchema>;

/** Approves, denies, or rejects a review (`bureau.reviews.resolve`). A rejection needs its reason. */
export async function resolveBureauReview(
  input: { readonly id: string; readonly decision: ReviewDecision; readonly reason?: string },
  options?: Options,
): Promise<ReviewResolution> {
  return resolveAnswerSchema.parse(await callBureau('bureau.reviews.resolve', input, options));
}
