/**
 * `bureau.reviews.*`: the review queue as catalog operations.
 *
 * Three operations over `Bureau.listPendingReviews`, `Bureau.getReview`, and
 * `Bureau.resolveReview`, served by `createBureauHandler` over JSON-RPC HTTP.
 * Each declares one of the two scopes in {@link BUREAU_SCOPES}.
 *
 * The wire shape is an allowlisted projection of {@link PendingReview}, not the
 * review itself: a tool approval's signed `approvalToken` and binding stay in the
 * Bureau, because resolving a review goes through its id and the Bureau holds the
 * token. A reviewer sees what it needs to decide (the tool, its arguments, and
 * the reason it paused) and nothing that would let it act outside `resolve`.
 *
 * @module bureau-reviews-operations
 */

import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import { BureauError } from '../create-bureau.ts';
import type { Bureau, PendingReview, ReviewStatus } from '../types.ts';

/** What the reviews operations read from the handler's `host`. */
export type BureauReviewsOperationHost = {
  readonly reviews: Pick<Bureau, 'listPendingReviews' | 'getReview' | 'resolveReview'>;
};

const reviewStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'rejected',
  'expired',
  'revoked',
  'canceled',
  'superseded',
]);

const reviewCommonFields = {
  id: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  agentName: z.string().optional(),
  /** Epoch milliseconds the review was requested. */
  requestedAt: z.number(),
  /** Milliseconds between `requestedAt` and the moment the review was read. */
  ageMilliseconds: z.number(),
  status: reviewStatusSchema,
};

const toolApprovalReviewSchema = z.object({
  ...reviewCommonFields,
  kind: z.literal('tool-approval'),
  approval: z.object({
    callId: z.string(),
    toolName: z.string(),
    arguments: z.unknown(),
    reason: z.string().optional(),
    /** What the tool is asking to do: an `approval` with its risk and operation, or an `input`. */
    action: z.looseObject({ type: z.enum(['approval', 'input']) }),
    /** Which policy tier paused the call; drives the inbox's danger badge. */
    policyPauseTier: z.enum(['capability', 'registry', 'tool']).optional(),
  }),
});

const humanWaitReviewSchema = z.object({
  ...reviewCommonFields,
  kind: z.literal('human-wait'),
  signalName: z.string(),
  prompt: z.string().optional(),
});

/** One review as it crosses the wire. */
export const bureauReviewSchema = z.discriminatedUnion('kind', [
  toolApprovalReviewSchema,
  humanWaitReviewSchema,
]);

export type BureauReview = z.infer<typeof bureauReviewSchema>;

/**
 * Project a review onto its wire shape. The projection is an allowlist, so a
 * field added to {@link PendingReview} later reaches no client until it is added
 * here on purpose.
 */
export function projectReview(
  review: PendingReview & { status: ReviewStatus },
): z.input<typeof bureauReviewSchema> {
  const common = {
    id: review.id,
    runId: review.runId,
    sessionId: review.sessionId,
    ...(review.agentName === undefined ? {} : { agentName: review.agentName }),
    requestedAt: review.requestedAt,
    ageMilliseconds: review.ageMilliseconds,
    status: review.status,
  };
  if (review.kind === 'tool-approval') {
    return {
      ...common,
      kind: 'tool-approval',
      approval: {
        callId: review.approval.callId,
        toolName: review.approval.toolName,
        arguments: review.approval.arguments,
        ...(review.approval.reason === undefined ? {} : { reason: review.approval.reason }),
        action: review.approval.action,
        ...(review.approval.policyPauseTier === undefined
          ? {}
          : { policyPauseTier: review.approval.policyPauseTier }),
      },
    };
  }
  return {
    ...common,
    kind: 'human-wait',
    signalName: review.signalName,
    ...(review.prompt === undefined ? {} : { prompt: review.prompt }),
  };
}

/**
 * The receipt states `bureau.reviews.resolve` can answer with, from the decision
 * document's receipt table:
 *
 * - `applied`: the decision took effect. This covers a landed `reject` too; the
 *   response's `decision` says which of approve, deny, or reject it was.
 * - `rejected`: the command was refused at admission and nothing was applied. v1
 *   reports a refusal as a fault, so no response carries it today; the state is
 *   reserved so a client that models the table does not break when it appears.
 * - `superseded`: the approval was re-gated, so the review stays pending under a
 *   replacement approval and the tool did not run.
 */
export const reviewReceiptSchema = z.enum(['applied', 'rejected', 'superseded']);

export type ReviewReceipt = z.infer<typeof reviewReceiptSchema>;

const transports = {
  http: false,
  jsonRpcHttp: true,
  jsonRpcWebSocket: false,
  jsonRpcStdio: false,
} as const;

/** A payload key that is not declared is `InvalidParams`, so a client cannot name a `principal`. */
const unknownKeyPolicy = { http: 'reject', jsonRpc: 'reject' } as const;

function reviewNotFound(identifier: string): OperationFault {
  return {
    code: 'NotFound',
    message: `No review with id "${identifier}"`,
    data: { resource: 'review', identifier },
  };
}

/**
 * Translate a Bureau error into the catalog fault a client branches on. Anything
 * that is not a {@link BureauError} is left to the pipeline, which masks it as an
 * internal failure.
 */
function reviewFault(error: unknown, identifier: string): unknown {
  if (!(error instanceof BureauError)) return error;
  switch (error.code) {
    case 'NOT_FOUND':
      return reviewNotFound(identifier);
    case 'CONFLICT':
      return { code: 'Conflict', message: error.message, data: { reason: error.message } };
    case 'BAD_REQUEST':
    case 'NOT_CONFIGURED':
    case 'RATE_LIMITED':
    case 'UNSUPPORTED_CAPABILITY':
      return { code: 'Unprocessable', message: error.message, data: { reason: error.message } };
  }
}

export const reviewsListOperation = defineOperation<
  z.ZodObject<Record<string, never>>,
  z.ZodObject<{ reviews: z.ZodArray<typeof bureauReviewSchema> }>,
  BureauReviewsOperationHost
>({
  name: 'bureau.reviews.list',
  mcpExposable: false,
  summary: 'List the reviews that are waiting for a decision',
  description:
    'Returns every pending review, which is what an inbox shows. A resolved review is reached by id with `bureau.reviews.get`. Requires `bureau.reviews:read`.',
  destructive: false,
  tags: ['Reviews'],
  inputSchema: z.object({}),
  outputSchema: z.object({ reviews: z.array(bureauReviewSchema) }),
  producibleFaults: ['InvalidParams'],
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['bureau.reviews:read'] } },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ host }) =>
    Promise.resolve({ reviews: host.reviews.listPendingReviews().map(projectReview) }),
});

export const reviewsGetOperation = defineOperation<
  z.ZodObject<{ id: z.ZodString }>,
  typeof bureauReviewSchema,
  BureauReviewsOperationHost
>({
  name: 'bureau.reviews.get',
  mcpExposable: false,
  summary: 'Read one review by id',
  description:
    'Returns a review, pending or resolved where the Bureau persists resolutions. Requires `bureau.reviews:read`.',
  destructive: false,
  tags: ['Reviews'],
  inputSchema: z.object({ id: z.string().min(1) }),
  outputSchema: bureauReviewSchema,
  producibleFaults: ['InvalidParams', 'NotFound'],
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['bureau.reviews:read'] } },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host }) => {
    const review = await host.reviews.getReview(input.id);
    if (review === undefined) throw reviewNotFound(input.id);
    return projectReview(review);
  },
});

const reviewsResolveInput = z
  .object({
    id: z.string().min(1),
    decision: z.enum(['approve', 'deny', 'reject']),
    /** Required, and non-blank, for `reject`. */
    reason: z.string().optional(),
  })
  .refine((input) => input.decision !== 'reject' || (input.reason ?? '').trim() !== '', {
    message: 'reject requires a reason',
    path: ['reason'],
  });

const reviewsResolveOutput = z.object({
  id: z.string(),
  kind: z.enum(['tool-approval', 'human-wait']),
  decision: z.enum(['approve', 'deny', 'reject']),
  receipt: reviewReceiptSchema,
  /** `tool-approval` reject only: the reason, for the next run to splice in. */
  feedback: z.string().optional(),
});

/**
 * The persisted `principal` string for a caller: the credential's namespace, then
 * its subject percent-encoded so no two subjects produce the same string. Only
 * an API key can reach this operation in v1.
 */
export function reviewerPrincipal(subject: string): string {
  return `api-key:${encodeURIComponent(subject)}`;
}

/**
 * The receipt for a resolution that reached the Bureau. A landed `reject` is
 * `applied`, not `rejected`: `rejected` means the command was refused and nothing
 * took effect, and a refusal is a fault in v1.
 */
function receiptFor(result: unknown): z.infer<typeof reviewReceiptSchema> {
  // `resumeApproval` re-ran the tool's policy and gated it again: the tool did
  // not run and the review remains pending under a replacement approval.
  if (
    typeof result === 'object' &&
    result !== null &&
    'outcome' in result &&
    result.outcome === 'action_required'
  ) {
    return 'superseded';
  }
  return 'applied';
}

export const reviewsResolveOperation = defineOperation<
  typeof reviewsResolveInput,
  typeof reviewsResolveOutput,
  BureauReviewsOperationHost
>({
  name: 'bureau.reviews.resolve',
  mcpExposable: false,
  summary: 'Approve, deny, or reject a pending review',
  description:
    'Resolves a pending review as the authenticated caller; the reviewer is never a payload field. `reject` requires a `reason`. The `receipt` is `applied` (including a landed reject, which `decision` reports) or `superseded`. Resolving a review that is already resolved answers 404 until command receipts exist. Requires `bureau.reviews:resolve`.',
  destructive: true,
  tags: ['Reviews'],
  inputSchema: reviewsResolveInput,
  outputSchema: reviewsResolveOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'Conflict', 'Forbidden', 'Unprocessable'],
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['bureau.reviews:resolve'] } },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    // The authentication step already refused an anonymous caller with 401. This
    // guards the one way past it: a caller that is authenticated but that the
    // deployment cannot attribute (a credential type v1 does not accept, whose
    // subject has no namespace to be recorded under). That is 403, not 401.
    if (principal.method !== 'api-key' || principal.subject === undefined) {
      const fault: OperationFault = {
        code: 'Forbidden',
        message: 'Resolving a review requires an API-key caller',
        data: { reason: 'unsupported credential' },
      };
      throw fault;
    }
    try {
      const result = await host.reviews.resolveReview({
        id: input.id,
        decision: input.decision,
        principal: reviewerPrincipal(principal.subject),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
      return {
        id: result.id,
        kind: result.kind,
        decision: result.decision,
        receipt: receiptFor(result.result),
        ...(result.feedback === undefined ? {} : { feedback: result.feedback }),
      };
    } catch (error) {
      throw reviewFault(error, input.id);
    }
  },
});

/** The three reviews operations, in registration order. */
export const bureauReviewsOperations = [
  reviewsListOperation,
  reviewsGetOperation,
  reviewsResolveOperation,
] as const;
