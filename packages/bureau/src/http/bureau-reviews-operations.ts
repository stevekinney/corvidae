/**
 * `bureau.reviews.*`: the review queue as catalog operations.
 *
 * Three operations over `Bureau.listPendingReviews`, `Bureau.getReview`, and
 * `Bureau.resolveReview`, served by `createBureauHandler` over JSON-RPC HTTP.
 *
 * Each is declared `authenticated`, because a review belongs to its run's owner
 * (the decision document's "the requester") and the owner needs no scope to
 * reach it. A principal sees and acts on the reviews of its own runs only, unless
 * it holds the operator scope: `bureau.reviews:read` covers list and get,
 * `bureau.reviews:resolve` covers resolve, and neither implies the other. A list
 * leaves out other owners' reviews, and a get or resolve of another owner's
 * review answers exactly as a missing id does, before anything is resolved, so a
 * denial writes no audit entry.
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
import type { Bureau, PendingReview, PendingToolApprovalReview, ReviewStatus } from '../types.ts';
import type { BureauScope } from './bureau-scopes.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from './owner-predicate.ts';

/** What the reviews operations read from the handler's `host`. */
export type BureauReviewsOperationHost = {
  readonly reviews: Pick<Bureau, 'listPendingReviews' | 'getReview' | 'resolveReview'>;
} & BureauOwnershipHost;

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

const operationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string(),
    filesTouched: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal('file-write'), filesTouched: z.array(z.string()) }),
  z.object({
    kind: z.literal('patch'),
    diff: z.string(),
    filesTouched: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal('other'), filesTouched: z.array(z.string()).optional() }),
]);

/**
 * The action a tool call asks to take, as a reviewer sees it. Each member lists
 * the fields that say what will happen and to what; the action's environment,
 * sandbox, idempotency key, snapshot id, policy version, and argument preview are
 * not among them (the arguments are already on the approval itself).
 */
const toolActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), message: z.string().optional() }),
  z.object({
    type: z.literal('approval'),
    message: z.string().optional(),
    risk: z.enum(['low', 'medium', 'high']),
    operation: operationSchema,
    /** ISO timestamp after which the approval can no longer be given. */
    expiresAt: z.string().optional(),
  }),
]);

const toolApprovalReviewSchema = z.object({
  ...reviewCommonFields,
  kind: z.literal('tool-approval'),
  /**
   * How many times the approval was superseded: 0 until a resolution is gated
   * again, then incremented each time. The review keeps its id across rounds, so
   * the round is what tells one supersession's resolution from the next.
   */
  round: z.number().int().min(0),
  approval: z.object({
    callId: z.string(),
    toolName: z.string(),
    arguments: z.unknown(),
    reason: z.string().optional(),
    /** What the tool is asking to do, reduced to what a reviewer needs to judge it. */
    action: toolActionSchema,
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

type ToolAction = PendingToolApprovalReview['approval']['action'];

function projectOperation(
  operation: Extract<ToolAction, { type: 'approval' }>['operation'],
): z.input<typeof operationSchema> {
  const files =
    operation.filesTouched === undefined ? {} : { filesTouched: operation.filesTouched };
  switch (operation.kind) {
    case 'command':
      return { kind: 'command', command: operation.command, ...files };
    case 'file-write':
      return { kind: 'file-write', filesTouched: operation.filesTouched };
    case 'patch':
      return { kind: 'patch', diff: operation.diff, ...files };
    case 'other':
      return { kind: 'other', ...files };
  }
}

/** Build the wire action field by field, so a field added to `ToolAction` stays off the wire. */
function projectAction(action: ToolAction): z.input<typeof toolActionSchema> {
  const message = action.message === undefined ? {} : { message: action.message };
  if (action.type === 'input') return { type: 'input', ...message };
  return {
    type: 'approval',
    ...message,
    risk: action.risk,
    operation: projectOperation(action.operation),
    ...(action.expiresAt === undefined ? {} : { expiresAt: action.expiresAt }),
  };
}

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
      round: review.round ?? 0,
      approval: {
        callId: review.approval.callId,
        toolName: review.approval.toolName,
        arguments: review.approval.arguments,
        ...(review.approval.reason === undefined ? {} : { reason: review.approval.reason }),
        action: projectAction(review.approval.action),
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

/** Whether `principal` may act on the review of `runId`: its run's owner, or the operator scope. */
async function mayAccessReview(
  host: BureauReviewsOperationHost,
  principal: Parameters<BureauOwnershipHost['ownership']['mayAccess']>[0]['principal'],
  runId: string,
  operatorScope: BureauScope,
): Promise<boolean> {
  // The operator scope needs no owner lookup, and a lookup that finds nothing
  // (a deleted run) leaves only the scope.
  const resourceOwner =
    principal.method !== 'unauthenticated' && principal.hasScope(operatorScope)
      ? undefined
      : await host.ownership.runOwner(runId);
  return host.ownership.mayAccess({ principal, resourceOwner, operatorScope });
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
    'Returns the pending reviews of the caller’s own runs, which is what an inbox shows; a caller holding `bureau.reviews:read` sees every owner’s. A resolved review is reached by id with `bureau.reviews.get`.',
  destructive: false,
  tags: ['Reviews'],
  inputSchema: z.object({}),
  outputSchema: z.object({ reviews: z.array(bureauReviewSchema) }),
  producibleFaults: ['InvalidParams'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ host, principal }) => {
    const pending = host.reviews.listPendingReviews();
    const visible = await Promise.all(
      pending.map(async (review) => {
        const allowed = await mayAccessReview(host, principal, review.runId, 'bureau.reviews:read');
        return allowed ? review : undefined;
      }),
    );
    return {
      reviews: visible.filter((review) => review !== undefined).map(projectReview),
    };
  },
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
    'Returns a review of one of the caller’s own runs, pending or resolved where the Bureau persists resolutions; a caller holding `bureau.reviews:read` reads any owner’s. Another owner’s review answers as a missing id does.',
  destructive: false,
  tags: ['Reviews'],
  inputSchema: z.object({ id: z.string().min(1) }),
  outputSchema: bureauReviewSchema,
  producibleFaults: ['InvalidParams', 'NotFound'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const review = await host.reviews.getReview(input.id);
    if (
      review === undefined ||
      !(await mayAccessReview(host, principal, review.runId, 'bureau.reviews:read'))
    ) {
      throw reviewNotFound(input.id);
    }
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
    'Resolves a pending review of one of the caller’s own runs as the authenticated caller; the reviewer is never a payload field. A caller holding `bureau.reviews:resolve` resolves any owner’s. `reject` requires a `reason`. The `receipt` is `applied` (including a landed reject, which `decision` reports) or `superseded`. Resolving a review that is already resolved, or one the caller may not resolve, answers 404 until command receipts exist. Resolving a tool approval also writes its outcome into the session’s conversation: the executed result on approve, an error result carrying the reason on deny and reject, each replacing the pending `action_required` result in place, so a run started next on the session answers an up-to-date conversation. A `superseded` receipt writes nothing.',
  destructive: true,
  tags: ['Reviews'],
  inputSchema: reviewsResolveInput,
  outputSchema: reviewsResolveOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'Conflict', 'Forbidden', 'Unprocessable'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    // The decision is checked before anything is resolved, and a caller who may
    // not resolve this review is told exactly what a caller naming a missing id
    // is told. Resolving writes the audit entry, so a denial writes none.
    const review = await host.reviews.getReview(input.id);
    if (
      review === undefined ||
      !(await mayAccessReview(host, principal, review.runId, 'bureau.reviews:resolve'))
    ) {
      throw reviewNotFound(input.id);
    }
    // The actor on the audit entry is the caller's owner string. The authentication
    // step already refused an anonymous caller with 401; this guards the one way
    // past it, a caller that is authenticated but that the deployment cannot
    // attribute (a credential type v1 does not accept). That is 403, not 401.
    const actor = ownerOfPrincipal(principal);
    if (actor === undefined) {
      const fault: OperationFault = {
        code: 'Forbidden',
        message: 'Resolving a review requires an API-key or local caller',
        data: { reason: 'unsupported credential' },
      };
      throw fault;
    }
    try {
      const result = await host.reviews.resolveReview({
        id: input.id,
        decision: input.decision,
        principal: actor,
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
