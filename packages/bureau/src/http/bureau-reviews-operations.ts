/**
 * `bureau.reviews.*`: the review queue as catalog operations.
 *
 * Three operations over `Bureau.reviews.list`, `Bureau.reviews.get`, and
 * `Bureau.reviews.resolve`, served by `createBureauHandler` over JSON-RPC HTTP.
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
 * A review whose run another Bureau process holds (COR-1579) is listed, read and
 * resolved here as well: the list adds the human waits it derives from durable
 * state for every running agent run, and get and resolve reach them through the
 * Bureau's own derivation by id.
 *
 * ## One list for the inbox and its Done tab (COR-1828)
 *
 * `bureau.reviews.list` takes `status: 'pending' | 'resolved'` (default `pending`),
 * `resolvedAfter` (resolved only), `limit` and `pageToken`, and merges two sources into
 * one ordered list: the Bureau's own reviews (`source: 'bureau'`, a tool approval or a human
 * wait) and, for a caller holding the Weft scope `reviews:read`, the durable engine's workflow
 * reviews (`source: 'engine'`, `kind: 'engine-review'`; its `completed` is this list's `resolved`).
 * A caller without that scope sees Bureau items only. Pending items run oldest request first
 * (`requestedAt` ascending); resolved ones, most recent decision first (`resolution.decidedAt`
 * descending); ties break on source (`bureau` first), then id. A page token is a position in that
 * order, bound to the filters it was issued for: under other filters it is `InvalidParams`.
 * An engine review keeps its engine words: `status` is `pending` or `completed`, and
 * `resolution.decision` is `approved`, `rejected` or `needs-changes`, which Bureau's `approve`,
 * `deny` and `reject` do not stand for.
 *
 * @module bureau-reviews-operations
 */

import {
  defineOperation,
  type OperationFault,
  type RegistryAgnosticEngine,
} from '@lostgradient/weft';
import { z } from 'zod';

import { reviewReceiptOf } from '../tasks/respond-to-task.ts';

import {
  ApprovalOutcomeNotWrittenError,
  BureauError,
  ReviewAnswerInvalidError,
  ReviewRoundChangedError,
} from '../create-bureau.ts';
import type {
  Bureau,
  PendingReview,
  PendingToolApprovalReview,
  ResolvedReview,
  ReviewResolutionFields,
  BureauReviews,
} from '../types.ts';
import type { BureauScope } from './bureau-scopes.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from './owner-predicate.ts';

/** What the reviews operations read from the handler's `host`. */
export type BureauReviewsOperationHost = {
  readonly reviews: Pick<BureauReviews, 'list' | 'get' | 'resolve'> &
    /**
     * COR-1579: what the list reads to add the parks of runs another process holds. A host that
     * provides neither lists this process's reviews alone.
     */
    Partial<Pick<BureauReviews, 'pendingOf' | 'listResolved'> & Pick<Bureau, 'durableEngine'>>;
} & BureauOwnershipHost;

/** How many running agent runs one `engine.list` page reads. */
const RUNNING_RUNS_PAGE_SIZE = 100;

/**
 * The pending reviews of this process, merged by id with the human waits derived for every running
 * agent run in the durable store, so a park another process holds is listed too. A parked run
 * stays `running`. This process's own entry wins over a derived one with the same id.
 */
async function pendingReviewsOfEveryProcess(
  reviews: BureauReviewsOperationHost['reviews'],
): Promise<PendingReview[]> {
  const local = reviews.list();
  const engine = reviews.durableEngine?.();
  const derive = reviews.pendingOf;
  if (engine === undefined || derive === undefined) return local;
  const merged = [...local];
  const seen = new Set(local.map((review) => review.id));
  // Paged by what each page reports, not by the size asked for, which the engine may cap.
  let offset = 0;
  for (;;) {
    const page = await engine.list({
      status: 'running',
      type: 'agentRun',
      limit: RUNNING_RUNS_PAGE_SIZE,
      offset,
    });
    const derived = await Promise.all(page.items.map((run) => derive(run.id)));
    for (const review of derived.flat()) {
      if (seen.has(review.id)) continue;
      seen.add(review.id);
      merged.push(review);
    }
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) return merged;
  }
}

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

/**
 * How a review left the queue, once it has: who closed it and when, and, for a decision, what was
 * decided. The note and what the Bureau kept of an approved answer ride along. An answer is never
 * here: `answerDigest` is a digest over its reference form, and `secretRefs` names the references
 * its secret fields were stored under (COR-1920), never a secret's value.
 */
const bureauResolutionSchema = z.object({
  /** Absent when the Bureau closed the review itself (an expiry, a revocation, a cancellation). */
  decision: z.enum(['approve', 'deny', 'reject']).optional(),
  /** The principal that decided, or the `system:*` principal that closed the review. */
  decidedBy: z.string(),
  /** Epoch milliseconds the review was closed. */
  decidedAt: z.number(),
  reason: z.string().optional(),
  /** A human wait's approved answer: SHA-256 of its canonical JSON with secret fields as `{ secretRef }`. */
  answerDigest: z.string().optional(),
  secretRefs: z.array(z.string()).optional(),
});

const reviewCommonFields = {
  /** Where the review comes from; every review of the Bureau's own says `bureau`. */
  source: z.literal('bureau'),
  id: z.string(),
  runId: z.string(),
  agentName: z.string().optional(),
  /** Epoch milliseconds the review was requested. */
  requestedAt: z.number(),
  /** Milliseconds between `requestedAt` and the moment the review was read. */
  /** For a resolved review, the milliseconds between `requestedAt` and the decision. */
  ageMilliseconds: z.number(),
  status: reviewStatusSchema,
  /** Present once the review has left the queue. */
  resolution: bureauResolutionSchema.optional(),
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
  sessionId: z.string(),
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
  /** Absent for the park of a run that has no session; its `runId` addresses it. */
  sessionId: z.string().optional(),
  kind: z.literal('human-wait'),
  signalName: z.string(),
  prompt: z.string().optional(),
  /**
   * The JSON Schema (2020-12) the answer must satisfy, when the question has one: the model's
   * per-call `answerSchema`, else the author's per-signal one. It carries the `x-` keywords that
   * choose the control (`x-labels`, `x-allowOther`, `x-kind`, `x-secret`, `x-asset`). Absent, any
   * answer is taken. `bureau.reviews.resolve` checks an `answer` against it.
   */
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A human review request of a durable workflow, as the engine keeps it (`ctx.waitForReview`), listed
 * beside the Bureau's own reviews (COR-1828). Its words are the engine's: `status` is `pending` or
 * `completed`, and a decision is `approved`, `rejected` or `needs-changes`. Its `id` is the engine's
 * review key and `runId` the workflow it belongs to. Resolving one is the engine's operation
 * (`weft.reviews.decide`), not `bureau.reviews.resolve`.
 */
const engineReviewSchema = z.object({
  source: z.literal('engine'),
  kind: z.literal('engine-review'),
  id: z.string(),
  /** The workflow the review belongs to. */
  runId: z.string(),
  /** Epoch milliseconds the review was requested. */
  requestedAt: z.number(),
  /** Milliseconds between `requestedAt` and the moment the review was read. */
  ageMilliseconds: z.number(),
  status: z.enum(['pending', 'completed']),
  reviewType: z.string(),
  reviewers: z.array(z.string()),
  allowPartial: z.boolean(),
  /** What the reviewer is asked to judge; whatever the workflow put there. */
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

/** One review of the Bureau's own as it crosses the wire. */
export const bureauReviewSchema = z.discriminatedUnion('kind', [
  toolApprovalReviewSchema,
  humanWaitReviewSchema,
]);

export type BureauReview = z.infer<typeof bureauReviewSchema>;

/** One item of `bureau.reviews.list`: a Bureau review, or a workflow review of the engine. */
export const listedReviewSchema = z.discriminatedUnion('kind', [
  toolApprovalReviewSchema,
  humanWaitReviewSchema,
  engineReviewSchema,
]);

export type ListedReview = z.infer<typeof listedReviewSchema>;

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

const DECISION_OF_STATUS = new Map<string, 'approve' | 'deny' | 'reject'>([
  ['approved', 'approve'],
  ['denied', 'deny'],
  ['rejected', 'reject'],
]);

/**
 * How a review that has left the queue was closed, when the Bureau knows who closed it and when.
 * A decision names what was decided; an expiry, a revocation or a cancellation names the
 * `system:*` principal and no decision.
 */
function projectResolution(review: PendingReview & ReviewResolutionFields): {
  resolution?: z.input<typeof bureauResolutionSchema>;
} {
  if (
    review.status === 'pending' ||
    review.resolvedBy === undefined ||
    review.resolvedAt === undefined
  ) {
    return {};
  }
  const decision = DECISION_OF_STATUS.get(review.status);
  return {
    resolution: {
      ...(decision === undefined ? {} : { decision }),
      decidedBy: review.resolvedBy,
      decidedAt: review.resolvedAt,
      ...(review.resolutionReason === undefined ? {} : { reason: review.resolutionReason }),
      ...(review.answerDigest === undefined ? {} : { answerDigest: review.answerDigest }),
      ...(review.secretRefs === undefined ? {} : { secretRefs: [...review.secretRefs] }),
    },
  };
}

/**
 * Project a review onto its wire shape. The projection is an allowlist, so a
 * field added to {@link PendingReview} later reaches no client until it is added
 * here on purpose.
 */
export function projectReview(
  review: PendingReview & ReviewResolutionFields,
): z.input<typeof bureauReviewSchema> {
  const common = {
    source: 'bureau' as const,
    id: review.id,
    runId: review.runId,
    ...(review.agentName === undefined ? {} : { agentName: review.agentName }),
    requestedAt: review.requestedAt,
    ageMilliseconds: review.ageMilliseconds,
    status: review.status,
    ...projectResolution(review),
  };
  if (review.kind === 'tool-approval') {
    return {
      ...common,
      sessionId: review.sessionId,
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
    ...(review.sessionId === undefined ? {} : { sessionId: review.sessionId }),
    kind: 'human-wait',
    signalName: review.signalName,
    ...(review.prompt === undefined ? {} : { prompt: review.prompt }),
    ...(review.inputSchema === undefined ? {} : { inputSchema: review.inputSchema }),
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

/** The token a client branches on to tell a decision whose outcome was not written from a lost race. */
export const APPROVAL_OUTCOME_NOT_WRITTEN = 'APPROVAL_OUTCOME_NOT_WRITTEN';

/** The token a client branches on to tell a review that moved to another round from a lost race. */
export const REVIEW_ROUND_CHANGED = 'REVIEW_ROUND_CHANGED';

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
export function reviewFault(error: unknown, identifier: string): unknown {
  if (!(error instanceof BureauError)) return error;
  // An answer that does not fit its question's schema: `InvalidParams`, one issue per field, with
  // each path rooted at the request's `answer` so it reads like any other invalid parameter.
  if (error instanceof ReviewAnswerInvalidError) {
    return {
      code: 'InvalidParams',
      message: error.message,
      data: {
        issues: error.issues.map((issue) => ({
          path: ['answer', ...issue.path],
          message: issue.message,
          code: issue.code,
        })),
      },
    } satisfies OperationFault;
  }
  switch (error.code) {
    case 'NOT_FOUND':
      return reviewNotFound(identifier);
    case 'CONFLICT': {
      // The decision took effect and only the write into the conversation failed,
      // which a client must not read as another resolver having won. Weft's wire for a
      // `Conflict` carries `data.reason` and none of the other fields, so the token a
      // client branches on is the start of the reason: `APPROVAL_OUTCOME_NOT_WRITTEN: `.
      if (error instanceof ApprovalOutcomeNotWrittenError) {
        return {
          code: 'Conflict',
          message: error.message,
          data: { reason: `${APPROVAL_OUTCOME_NOT_WRITTEN}: ${error.message}` },
        };
      }
      // The review was replaced under the same id by another resolver's supersession, so the
      // round the caller read is gone and nothing took effect: it reads the review again.
      if (error instanceof ReviewRoundChangedError) {
        return {
          code: 'Conflict',
          message: error.message,
          data: { reason: `${REVIEW_ROUND_CHANGED}: ${error.message}` },
        };
      }
      return { code: 'Conflict', message: error.message, data: { reason: error.message } };
    }
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

const DEFAULT_PAGE_LIMIT = 50;

const reviewsListInput = z
  .object({
    status: z
      .enum(['pending', 'resolved'])
      .optional()
      .describe(
        'Which reviews to list: `pending` (the default) or `resolved`, the ones a person has decided, which is what a Done tab shows.',
      ),
    resolvedAfter: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'With `status: "resolved"`: only the reviews decided at or after this instant, in epoch milliseconds.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('The most reviews to return in one page, from 1 to 100. Defaults to 50.'),
    pageToken: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The `nextPageToken` of the previous page, to continue that listing. An opaque position, valid only with the `status` and `resolvedAfter` it was issued for.',
      ),
  })
  .refine((input) => input.resolvedAfter === undefined || input.status === 'resolved', {
    message: '`resolvedAfter` applies to `status: "resolved"`',
    path: ['resolvedAfter'],
  });

const reviewsListOutput = z.object({
  reviews: z.array(listedReviewSchema),
  /** `null` when no review remains after this page. */
  nextPageToken: z.string().nullable(),
});

/** Where an item sits in the merged order: the time it is ordered by, its source, then its id. */
type ListPosition = {
  readonly at: number;
  readonly source: 'bureau' | 'engine';
  readonly id: string;
};

type ListEntry = ListPosition & { readonly item: z.input<typeof listedReviewSchema> };

const SOURCE_RANK = { bureau: 0, engine: 1 } as const;

/** Whether `a` comes before `b`: pending oldest request first, resolved latest decision first. */
function comesBefore(status: 'pending' | 'resolved', a: ListPosition, b: ListPosition): boolean {
  if (a.at !== b.at) return status === 'pending' ? a.at < b.at : a.at > b.at;
  if (a.source !== b.source) return SOURCE_RANK[a.source] < SOURCE_RANK[b.source];
  return a.id < b.id;
}

/** The filters a page token is bound to. */
function listFilterKey(input: { status?: string | undefined; resolvedAfter?: number | undefined }) {
  return `${input.status ?? 'pending'}|${String(input.resolvedAfter ?? '')}`;
}

function encodePageToken(filters: string, position: ListPosition): string {
  return Buffer.from(JSON.stringify({ v: 1, filters, ...position })).toString('base64url');
}

function invalidPageToken(message: string, code: string): OperationFault {
  return {
    code: 'InvalidParams',
    message,
    data: { issues: [{ path: ['pageToken'], message, code }] },
  };
}

/** The position a token holds; a token that is not ours, or that another filter issued, is `InvalidParams`. */
function decodePageToken(token: string, filters: string): ListPosition {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw invalidPageToken('The page token is not one this list issued', 'page-token-malformed');
  }
  const held =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  if (
    held['v'] !== 1 ||
    typeof held['filters'] !== 'string' ||
    typeof held['at'] !== 'number' ||
    (held['source'] !== 'bureau' && held['source'] !== 'engine') ||
    typeof held['id'] !== 'string'
  ) {
    throw invalidPageToken('The page token is not one this list issued', 'page-token-malformed');
  }
  if (held['filters'] !== filters) {
    throw invalidPageToken(
      'The page token was issued for other filters than this request names',
      'page-token-filters-changed',
    );
  }
  return { at: held['at'], source: held['source'], id: held['id'] };
}

/** An engine review as the list shows it. */
function projectEngineReview(
  entry: Awaited<ReturnType<RegistryAgnosticEngine['listReviews']>>[number],
  now: number,
): z.input<typeof engineReviewSchema> {
  return {
    source: 'engine',
    kind: 'engine-review',
    id: entry.reviewId,
    runId: entry.workflowId,
    requestedAt: entry.createdAt,
    ageMilliseconds:
      entry.status === 'completed' ? entry.timestamp - entry.createdAt : now - entry.createdAt,
    status: entry.status,
    reviewType: entry.reviewType,
    reviewers: [...entry.reviewers],
    allowPartial: entry.allowPartial,
    artifact: entry.artifact,
    ...(entry.status === 'completed'
      ? {
          resolution: {
            decision: entry.decision,
            decidedBy: entry.reviewer,
            decidedAt: entry.timestamp,
            ...(entry.feedback === undefined ? {} : { reason: entry.feedback }),
          },
        }
      : {}),
  };
}

/** The resolved record, read as {@link BureauReviews.get} reads a closed review. */
function reviewOfResolved(resolved: ResolvedReview): PendingReview & ReviewResolutionFields {
  return {
    ...resolved.review,
    // The time the review waited for its decision, not the time since it was asked.
    ageMilliseconds: Math.max(0, resolved.decidedAt - resolved.review.requestedAt),
    resolvedBy: resolved.decidedBy,
    resolvedAt: resolved.decidedAt,
    ...(resolved.reason === undefined ? {} : { resolutionReason: resolved.reason }),
    ...(resolved.answerDigest === undefined ? {} : { answerDigest: resolved.answerDigest }),
    ...(resolved.secretRefs === undefined ? {} : { secretRefs: resolved.secretRefs }),
  };
}

export const reviewsListOperation = defineOperation<
  typeof reviewsListInput,
  typeof reviewsListOutput,
  BureauReviewsOperationHost
>({
  name: 'bureau.reviews.list',
  mcpExposable: true,
  summary: 'List the reviews that are waiting for a decision, or that have been decided',
  description:
    'Returns the reviews of the caller’s own runs, which is what an inbox shows; a caller holding `bureau.reviews:read` sees every owner’s. `status` is `pending` (the default: oldest request first, by `requestedAt`) or `resolved` (the reviews a person decided, latest decision first, by `resolution.decidedAt`, optionally only those decided at or after `resolvedAfter`); each item carries `source`, `bureau` for a tool approval or a question the Bureau holds, and `engine` for a workflow review of the durable engine (`kind: "engine-review"`), which only a caller holding the Weft scope `reviews:read` is shown. Ties break on source, then id. Pages with `limit` (1 to 100, default 50) and `pageToken`; `nextPageToken` is `null` when no review remains. A token is an opaque position in that order, valid only with the `status` and `resolvedAfter` it was issued for; any other token is `InvalidParams`. A resolved review is kept until `retention.audit` retires it, and carries `resolution` (who decided, what, and when); a secret answer appears only as its reference, never its value. A review that expired, was revoked or was canceled has no decision and is not listed as resolved; `bureau.reviews.get` still reads it.',
  destructive: false,
  tags: ['Reviews'],
  inputSchema: reviewsListInput,
  outputSchema: reviewsListOutput,
  producibleFaults: ['InvalidParams'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const status = input.status ?? 'pending';
    const filters = listFilterKey(input);
    const after =
      input.pageToken === undefined ? undefined : decodePageToken(input.pageToken, filters);
    const entries: ListEntry[] = [];
    const include = (entry: ListEntry): void => {
      if (after === undefined || comesBefore(status, after, entry)) entries.push(entry);
    };

    if (status === 'pending') {
      const pending = await pendingReviewsOfEveryProcess(host.reviews);
      const visible = await Promise.all(
        pending.map(async (review) =>
          (await mayAccessReview(host, principal, review.runId, 'bureau.reviews:read'))
            ? review
            : undefined,
        ),
      );
      for (const review of visible) {
        if (review === undefined) continue;
        include({
          at: review.requestedAt,
          source: 'bureau',
          id: review.id,
          item: projectReview(review),
        });
      }
    } else {
      const resolved =
        (await host.reviews.listResolved?.(
          input.resolvedAfter === undefined ? {} : { resolvedAfter: input.resolvedAfter },
        )) ?? [];
      for (const record of resolved) {
        // The owner of record, kept with the record, decides: the run may be gone by now.
        const allowed = host.ownership.mayAccess({
          principal,
          resourceOwner: record.owner,
          operatorScope: 'bureau.reviews:read',
        });
        if (!allowed) continue;
        include({
          at: record.decidedAt,
          source: 'bureau',
          id: record.review.id,
          item: projectReview(reviewOfResolved(record)),
        });
      }
    }

    // The engine's reviews, only for a caller the engine's own list would serve.
    const engine = host.reviews.durableEngine?.();
    if (
      engine !== undefined &&
      typeof engine.listReviews === 'function' &&
      principal.method !== 'unauthenticated' &&
      principal.hasScope('reviews:read')
    ) {
      const now = Date.now();
      const listed = await engine.listReviews({
        status: status === 'pending' ? 'pending' : 'completed',
      });
      for (const entry of listed) {
        const decidedAt = entry.status === 'completed' ? entry.timestamp : undefined;
        if (
          decidedAt !== undefined &&
          input.resolvedAfter !== undefined &&
          decidedAt < input.resolvedAfter
        ) {
          continue;
        }
        include({
          at: decidedAt ?? entry.createdAt,
          source: 'engine',
          id: entry.reviewId,
          item: projectEngineReview(entry, now),
        });
      }
    }

    entries.sort((a, b) => (comesBefore(status, a, b) ? -1 : comesBefore(status, b, a) ? 1 : 0));
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      reviews: page.map((entry) => entry.item),
      nextPageToken:
        entries.length > limit && last !== undefined
          ? encodePageToken(filters, { at: last.at, source: last.source, id: last.id })
          : null,
    };
  },
});

export const reviewsGetOperation = defineOperation<
  z.ZodObject<{ id: z.ZodString }>,
  typeof bureauReviewSchema,
  BureauReviewsOperationHost
>({
  name: 'bureau.reviews.get',
  mcpExposable: true,
  summary: 'Read one review by id',
  description:
    'Returns a review of one of the caller’s own runs, pending or resolved where the Bureau persists resolutions; a caller holding `bureau.reviews:read` reads any owner’s. Another owner’s review answers as a missing id does.',
  destructive: false,
  tags: ['Reviews'],
  inputSchema: z.object({
    id: z.string().min(1).describe('The identifier of the review to read.'),
  }),
  outputSchema: bureauReviewSchema,
  producibleFaults: ['InvalidParams', 'NotFound'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const review = await host.reviews.get(input.id);
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
    id: z.string().min(1).describe('The identifier of the review to resolve.'),
    decision: z
      .enum(['approve', 'deny', 'reject'])
      .describe('Whether to `approve` the review, `deny` it, or `reject` it with a `reason`.'),
    reason: z.string().optional().describe('Required, and non-blank, for `reject`.'),
    answer: z
      .unknown()
      .optional()
      .describe(
        'Approving a human wait: the answer, delivered as the signal’s payload. When the review carries an `inputSchema` the answer must satisfy it, and is required; a wait with no schema takes any answer. Ignored for `deny` and `reject`, and refused for a tool approval, which takes no answer.',
      ),
    round: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'The `round` of the review the caller read. A re-gated tool approval keeps its id and advances its round; when this is given and the review is no longer at it, nothing is decided and the answer is a `Conflict`. A human wait is always at round 0. Omitted, the call is not fenced.',
      ),
    remember: z
      .boolean()
      .optional()
      .describe(
        'Approving a tool approval: also allow its tool for the rest of this chat (`Allow for the rest of this chat`). Refused with `Unprocessable` for a human wait and for a `deny` or `reject`.',
      ),
  })
  // COR-1920: a field the operation does not define is refused, not dropped.
  .strict()
  .refine((input) => input.decision !== 'reject' || (input.reason ?? '').trim() !== '', {
    message: 'reject requires a reason',
    path: ['reason'],
  })
  .refine((input) => input.remember !== true || input.decision === 'approve', {
    message: 'remember applies to approving a tool approval',
    path: ['remember'],
  });

const reviewsResolveOutput = z.object({
  id: z.string(),
  kind: z.enum(['tool-approval', 'human-wait']),
  decision: z.enum(['approve', 'deny', 'reject']),
  receipt: reviewReceiptSchema,
  /** `tool-approval` reject only: the reason, for the next run to splice in. */
  feedback: z.string().optional(),
  /**
   * Present when the call asked to `remember`: `true` once the grant was stored with the decision,
   * `false` when it was not (the tool did not run, or the chat is gone).
   */
  remembered: z.boolean().optional(),
});

export const reviewsResolveOperation = defineOperation<
  typeof reviewsResolveInput,
  typeof reviewsResolveOutput,
  BureauReviewsOperationHost
>({
  name: 'bureau.reviews.resolve',
  mcpExposable: true,
  summary: 'Approve, deny, or reject a pending review',
  description:
    'Resolves a pending review of one of the caller’s own runs as the authenticated caller; the reviewer is never a payload field. A caller holding `bureau.reviews:resolve` resolves any owner’s. `reject` requires a `reason`. The `receipt` is `applied` (including a landed reject, which `decision` reports) or `superseded`. Resolving a review that is already resolved answers `Conflict` when the call asks for a different decision than the one recorded (a resolver that lost), and 404 when it repeats that decision, until command receipts exist; one the caller may not resolve answers 404. `remember: true` on approving a tool approval also allows its tool for the rest of the chat: the next ask for it in that chat that the agent file would make by `on-changes` runs without asking, and no other chat, fork, tool, `always` or `blocked` value, agent-wide always mode or read-only restriction is affected; the response says `remembered`. Resolving a tool approval also writes its outcome into the session’s conversation: the executed result on approve, an error result carrying the reason on deny and reject, each replacing the pending `action_required` result in place, so a run started next on the session answers an up-to-date conversation. A `superseded` receipt writes nothing. Approving a human wait takes an `answer`; when the review has an `inputSchema` the answer is checked against it before anything is decided, and one that does not fit answers `InvalidParams` with `data.issues` (`path` rooted at `answer`, `message`, and `code`, the schema keyword that failed) and leaves the review pending. `round` is the round of the review the caller read (`bureau.reviews.get` and `list` return it): a re-gated approval keeps its id and advances its round, so a decision made on round N is refused with a `Conflict` once the review is at another round, before anything is decided, written, or audited. A `Conflict` whose `reason` begins `REVIEW_ROUND_CHANGED: ` is that refusal (nothing took effect; read the review again); one that begins `APPROVAL_OUTCOME_NOT_WRITTEN: ` means the decision took effect (the tool ran or was refused) and only that write failed; any other `Conflict` is a resolver that lost. Omit `round` and the call is not fenced.',
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
    const review = await host.reviews.get(input.id);
    if (
      review === undefined ||
      !(await mayAccessReview(host, principal, review.runId, 'bureau.reviews:resolve'))
    ) {
      throw reviewNotFound(input.id);
    }
    if (input.remember === true && review.kind !== 'tool-approval') {
      const fault: OperationFault = {
        code: 'Unprocessable',
        message: 'Only a tool approval can be remembered; a human wait takes an answer',
        data: { reason: 'remember addressed to a human wait' },
      };
      throw fault;
    }
    if (input.answer !== undefined && review.kind === 'tool-approval') {
      const fault: OperationFault = {
        code: 'Unprocessable',
        message: 'An answer addresses a human wait; a tool approval takes a decision',
        data: { reason: 'answer addressed to a tool approval' },
      };
      throw fault;
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
      const result = await host.reviews.resolve({
        id: input.id,
        decision: input.decision,
        principal: actor,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.round === undefined ? {} : { round: input.round }),
        ...(input.answer === undefined ? {} : { payload: input.answer }),
        ...(input.remember === true ? { remember: true } : {}),
      });
      return {
        id: result.id,
        kind: result.kind,
        decision: result.decision,
        receipt: reviewReceiptOf(result.result),
        ...(result.feedback === undefined ? {} : { feedback: result.feedback }),
        ...(result.remembered === undefined ? {} : { remembered: result.remembered }),
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
