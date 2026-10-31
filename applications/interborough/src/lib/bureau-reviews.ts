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

/**
 * How a review left the queue: who closed it, when, and what was decided. A secret answer is only
 * ever a reference here (`secretRefs`), and the answer a digest; the value is never sent.
 */
const resolutionSchema = z.object({
  /** Absent when the Bureau closed the review itself (an expiry, a revocation, a cancellation). */
  decision: z.enum(['approve', 'deny', 'reject']).optional(),
  decidedBy: z.string(),
  /** Epoch milliseconds the review was closed. */
  decidedAt: z.number(),
  reason: z.string().optional(),
  answerDigest: z.string().optional(),
  secretRefs: z.array(z.string()).optional(),
});

const reviewCommon = {
  /**
   * Where the review comes from; the Bureau's own say `bureau`. The Bureau always says, so a stand-in
   * that leaves it off is read as its own.
   */
  source: z.literal('bureau').default('bureau'),
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
  /** Present once the review has left the queue. */
  resolution: resolutionSchema.optional(),
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
    /** The JSON Schema the answer must satisfy; it says which control draws the question. */
    inputSchema: z.record(z.string(), z.unknown()).optional(),
  }),
]);

/**
 * A workflow review of the durable engine, listed beside the Bureau's own (`source: 'engine'`).
 * It keeps the engine's words: `pending` or `completed`, and a decision of `approved`, `rejected`
 * or `needs-changes`.
 */
export const engineReviewSchema = z.object({
  source: z.literal('engine'),
  kind: z.literal('engine-review'),
  id: z.string(),
  /** The workflow the review belongs to. */
  runId: z.string(),
  requestedAt: z.number(),
  ageMilliseconds: z.number(),
  status: z.enum(['pending', 'completed']),
  reviewType: z.string(),
  reviewers: z.array(z.string()),
  allowPartial: z.boolean(),
  artifact: z.unknown().optional(),
  resolution: z
    .object({
      decision: z.enum(['approved', 'rejected', 'needs-changes']),
      decidedBy: z.string(),
      decidedAt: z.number(),
      reason: z.string().optional(),
    })
    .optional(),
});

/** One item of `bureau.reviews.list`: a Bureau review or an engine review. */
export const listedReviewSchema = z.discriminatedUnion('kind', [
  ...bureauReviewSchema.options,
  engineReviewSchema,
]);

/** A review waiting on a person: either a tool approval or a human wait. */
export type BureauReview = z.infer<typeof bureauReviewSchema>;
/** A workflow review of the durable engine. */
export type EngineReview = z.infer<typeof engineReviewSchema>;
/** One item of the merged review list. */
export type ListedReview = z.infer<typeof listedReviewSchema>;
/** A review that asks whether a gated tool call may run. */
export type BureauToolApproval = Extract<BureauReview, { kind: 'tool-approval' }>;
/** A review that asks a person for the input a run is parked on. */
export type BureauHumanWait = Extract<BureauReview, { kind: 'human-wait' }>;

type Options = { readonly signal?: AbortSignal };

const listAnswerSchema = z.object({
  reviews: z.array(listedReviewSchema),
  // The Bureau always says; a stand-in that leaves it off ends the list.
  nextPageToken: z.string().nullish(),
});

/** What `bureau.reviews.list` filters and pages by. */
export type ReviewsQuery = {
  /** `pending` (the default) or `resolved`, the reviews a person decided. */
  readonly status?: 'pending' | 'resolved';
  /** With `resolved`: only those decided at or after this instant, in epoch milliseconds. */
  readonly resolvedAfter?: number;
  /** The most reviews in one page, from 1 to 100; the Bureau's default is 50. */
  readonly limit?: number;
  /** The `nextPageToken` of the previous page, for the same `status` and `resolvedAfter`. */
  readonly pageToken?: string;
};

/**
 * One page of the merged review list (`bureau.reviews.list`): the Bureau's reviews and, for a caller
 * who may read the engine's, its workflow reviews, in one order. Pending ones run oldest request
 * first; resolved ones, latest decision first. `nextPageToken` is `null` on the last page.
 */
export async function pageReviews(
  query: ReviewsQuery = {},
  options?: Options,
): Promise<{ readonly reviews: readonly ListedReview[]; readonly nextPageToken: string | null }> {
  const page = listAnswerSchema.parse(await callBureau('bureau.reviews.list', query, options));
  return { reviews: page.reviews, nextPageToken: page.nextPageToken ?? null };
}

/**
 * The reviews waiting for a decision, from the caller's own runs (`bureau.reviews.list`), every
 * page of them. The engine's workflow reviews are left out: the Reviews screen reads those itself.
 */
export async function listBureauReviews(options?: Options): Promise<readonly BureauReview[]> {
  const reviews: BureauReview[] = [];
  let pageToken: string | undefined;
  do {
    const page = await pageReviews(pageToken === undefined ? {} : { pageToken }, options);
    for (const review of page.reviews) if (review.source === 'bureau') reviews.push(review);
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken !== undefined);
  return reviews;
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
  /** Present when the call asked to remember: whether the grant was stored with the decision. */
  remembered: z.boolean().optional(),
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
 * `remember` approves a tool approval and allows its tool for the rest of the chat; the Bureau
 * refuses it on a human wait and on a deny or reject.
 */
export async function resolveBureauReview(
  input: {
    readonly id: string;
    readonly decision: ReviewDecision;
    readonly reason?: string;
    readonly round?: number;
    readonly remember?: boolean;
  },
  options?: Options,
): Promise<ReviewResolution> {
  return resolveAnswerSchema.parse(await callBureau('bureau.reviews.resolve', input, options));
}
