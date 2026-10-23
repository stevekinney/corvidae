/**
 * `bureau.goals.*`: the durable goals of a Bureau (COR-1482), over `bureau.goals`.
 *
 * A goal belongs to the principal that created it. A caller reads and cancels its own goals
 * without any scope; `bureau.goals:read` grants every owner's to `list` and `get`, and
 * `bureau.goals:write` grants `cancel`, and neither implies the other. A goal the caller may not
 * see, or cancel, is answered exactly as a missing one. `create` makes a goal the caller owns, so
 * it needs no scope; the owner comes from the caller's credential and never from a payload.
 *
 * A goal's `revision` advances on every write to its record, a controller transition included.
 * `cancel` takes `expectedRevision`, compared inside the store's compare-and-swap that writes the
 * cancellation marker; a mismatch is a `StaleRevision` fault carrying the revision now current,
 * and nothing is written.
 *
 * What a goal's views leave out: its prompt and instructions (the objective's text, like a task's
 * message), each attempt's validator feedback and evidence, and its audit log. A view is the
 * goal's control-plane state: where it stands, what its attempts were, what it has used.
 *
 * `fresh-from-artifact` is not offered over the management plane. That policy seeds a retry from a
 * validated handoff artifact the Bureau's own `resolveFreshAttemptSource` must vouch for, and a
 * JSON caller has no such artifact to name.
 *
 * @module goals-operations
 */

import { sha256HexSync } from '@lostgradient/cryptography';
import { defineOperation, type OperationFault, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import type { BureauGoalCreateOutcome } from '../../goal-types.ts';
import type { GoalState } from '../../goal-state.ts';
import { ownerOrLocal } from '../../owner-of-record.ts';
import type { Bureau } from '../../types.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  DEFAULT_PAGE_LIMIT,
  pageFields,
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What the goal operations read from the handler's `host`. */
export type BureauGoalsOperationHost = BureauOwnershipHost & {
  readonly goals: Pick<Bureau['goals'], 'create' | 'get' | 'list' | 'cancel'>;
};

const goalStatus = z.enum([
  'pending',
  'running',
  'evaluating',
  'retrying',
  'succeeded',
  'exhausted',
  'failed',
  'canceled',
]);
const goalIdentifier = z.string().min(1).max(256);

const usageSchema = z.object({
  steps: z.number(),
  tokens: z.number(),
  costUsd: z.number().nullable(),
});

const goalViewSchema = z.object({
  goalRunId: z.string(),
  owner: z.string(),
  agentName: z.string(),
  status: goalStatus,
  terminalReason: z.string().nullable(),
  /** Advances on every write to the goal's record: pass it back as `expectedRevision`. */
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  cancellation: z.object({ requestedAt: z.string(), reason: z.string().nullable() }).nullable(),
  bounds: z.object({
    maximumAttempts: z.number(),
    maximumTotalDurationMs: z.number().nullable(),
    maximumTotalSteps: z.number().nullable(),
    maximumTotalTokens: z.number().nullable(),
    maximumTotalCostUsd: z.number().nullable(),
  }),
  usage: usageSchema.extend({ attempts: z.number(), durationMs: z.number() }),
  attempts: z.array(
    z.object({
      attemptId: z.string(),
      attemptIndex: z.number().int(),
      runId: z.string(),
      status: z.enum(['running', 'evaluating', 'passed', 'failed', 'aborted']),
      startedAt: z.string(),
      completedAt: z.string().nullable(),
      finishReason: z.string().nullable(),
      usage: usageSchema,
    }),
  ),
});

type GoalView = z.infer<typeof goalViewSchema>;

function viewOf(goal: GoalState): GoalView {
  const { bounds } = goal;
  return {
    goalRunId: goal.goalRunId,
    owner: ownerOrLocal(goal.principal),
    agentName: goal.objective.agentName,
    status: goal.status,
    terminalReason: goal.terminalReason ?? null,
    revision: goal.revision,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    closedAt: goal.closedAt ?? null,
    cancellation:
      goal.cancellation === undefined
        ? null
        : {
            requestedAt: goal.cancellation.requestedAt,
            reason: goal.cancellation.reason ?? null,
          },
    bounds: {
      maximumAttempts: bounds.maximumAttempts,
      maximumTotalDurationMs: bounds.maximumTotalDurationMs ?? null,
      maximumTotalSteps: bounds.maximumTotalSteps ?? null,
      maximumTotalTokens: bounds.maximumTotalTokens ?? null,
      maximumTotalCostUsd: bounds.maximumTotalCostUsd ?? null,
    },
    usage: {
      attempts: goal.usage.attempts,
      steps: goal.usage.steps,
      tokens: goal.usage.tokens,
      costUsd: goal.usage.costUsd ?? null,
      durationMs: goal.usage.durationMs,
    },
    attempts: goal.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      attemptIndex: attempt.attemptIndex,
      runId: attempt.runId,
      status: attempt.status,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt ?? null,
      finishReason: attempt.finishReason ?? null,
      usage: {
        steps: attempt.usage.steps,
        tokens: attempt.usage.tokens,
        costUsd: attempt.usage.costUsd ?? null,
      },
    })),
  };
}

/** Whether `principal` holds an operator scope (an unauthenticated principal holds none). */
function holds(principal: Principal, scope: 'bureau.goals:read' | 'bureau.goals:write'): boolean {
  return principal.method !== 'unauthenticated' && principal.hasScope(scope);
}

/**
 * The goal `goalRunId` when `principal` may use `operatorScope` on it, and `NotFound` otherwise:
 * a goal the caller may not see and one that does not exist are the same answer. The read is the
 * Bureau's trusted one, because the predicate is what decides who may see a goal.
 */
async function goalFor(
  host: BureauGoalsOperationHost,
  principal: Principal,
  goalRunId: string,
  operatorScope: 'bureau.goals:read' | 'bureau.goals:write',
): Promise<GoalState> {
  const goal = await host.goals.get(goalRunId);
  if (
    goal === undefined ||
    !host.ownership.mayAccess({
      principal,
      resourceOwner: ownerOrLocal(goal.principal),
      operatorScope,
    })
  ) {
    throw resourceNotFound('goal', goalRunId);
  }
  return goal;
}

const listInput = z.object({ status: goalStatus.optional(), ...pageFields });
const listOutput = z.object({
  goals: z.array(goalViewSchema),
  nextOffset: z.number().int().nullable(),
});

export const goalsListOperation = defineOperation<
  typeof listInput,
  typeof listOutput,
  BureauGoalsOperationHost
>({
  name: 'bureau.goals.list',
  mcpExposable: true,
  summary: 'List goals',
  description:
    'Lists the caller’s own goals, oldest first, ended ones included; a caller holding `bureau.goals:read` lists every owner’s. `status` narrows to one status. Pages with `limit` (1 to 100, default 50) and `offset`; `nextOffset` is `null` on the last page. A view carries the goal’s `revision` and its attempts, and never its prompt or instructions.',
  destructive: false,
  tags: ['Goals'],
  inputSchema: listInput,
  outputSchema: listOutput,
  producibleFaults: ['InvalidParams'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const everyOwner = holds(principal, 'bureau.goals:read');
    const caller = ownerOfPrincipal(principal);
    if (!everyOwner && caller === undefined) return { goals: [], nextOffset: null };
    const goals = await host.goals.list({
      ...(everyOwner || caller === undefined ? {} : { principal: caller }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const start = input.offset ?? 0;
    return {
      goals: goals.slice(start, start + limit).map(viewOf),
      nextOffset: goals.length > start + limit ? start + limit : null,
    };
  },
});

const getInput = z.object({ goalRunId: goalIdentifier });

export const goalsGetOperation = defineOperation<
  typeof getInput,
  typeof goalViewSchema,
  BureauGoalsOperationHost
>({
  name: 'bureau.goals.get',
  mcpExposable: true,
  summary: 'Read one goal',
  description:
    'Returns one of the caller’s own goals; a caller holding `bureau.goals:read` reads any owner’s. Another owner’s goal answers as a missing one does. The view carries the goal’s `revision`, to pass back as `expectedRevision`, and its attempts, and never its prompt or instructions.',
  destructive: false,
  tags: ['Goals'],
  inputSchema: getInput,
  outputSchema: goalViewSchema,
  producibleFaults: ['InvalidParams', 'NotFound'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) =>
    viewOf(await goalFor(host, principal, input.goalRunId, 'bureau.goals:read')),
});

const positiveInteger = z.number().int().positive();

/**
 * The goal id an owner's `idempotencyKey` names: the key under a digest of the owner. Ids are
 * global, so a key the caller chose must not be able to meet another owner's goal: that would
 * answer a `Conflict` for an id the caller does not own, and tell it the id is taken. Under the
 * owner's digest, one owner's key can only ever meet that owner's own goal.
 */
function goalRunIdFor(owner: string, idempotencyKey: string): string {
  return `${sha256HexSync(owner).slice(0, 16)}-${idempotencyKey}`;
}

const createInput = z.object({
  /**
   * Makes `create` idempotent for the caller: the same request under the same key is the same
   * goal. The goal's id is derived from the key and the caller, so it is never another owner's.
   * Omitted, the Bureau mints the id.
   */
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
  /** The catalog agent that runs each attempt. */
  agentName: z.string().min(1).max(256),
  prompt: z.string().min(1).max(100_000),
  instructions: z.string().max(100_000).optional(),
  identity: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  /** A validator this Bureau was configured with, by exact name and version. */
  validator: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
  bounds: z.strictObject({
    maximumAttempts: positiveInteger,
    maximumTotalDurationMs: positiveInteger.optional(),
    maximumTotalSteps: positiveInteger.optional(),
    maximumTotalTokens: positiveInteger.optional(),
    maximumTotalCostUsd: z.number().positive().optional(),
  }),
  conversationPolicy: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('continue') }),
      z.strictObject({
        kind: z.literal('fork-from-baseline'),
        throughRun: z.number().int().min(0),
      }),
    ])
    .optional(),
  retryPolicy: z
    .strictObject({
      retryOn: z.array(
        z.enum(['validator-fail-retryable', 'validator-unavailable', 'validator-canceled']),
      ),
    })
    .optional(),
  validatorTimeoutMs: positiveInteger.optional(),
  requireDeterministicValidation: z.boolean().optional(),
});

const createOutput = z.object({
  /** `created` for a new goal, `existing` for the same request repeated. */
  outcome: z.enum(['created', 'existing']),
  goal: goalViewSchema,
  /**
   * How the goal's controller stood once the call returned. The goal is committed whatever this
   * says: `started` (the controller runs), `not-needed` (the goal has ended, or a cancellation is
   * recorded), or `start-failed` (the record exists, no controller does, so the goal stays
   * `pending` until the Bureau recovers it; `reason` says why). `null` for an `existing` goal the
   * call did not look at.
   */
  controller: z
    .object({
      status: z.enum(['started', 'not-needed', 'start-failed']),
      reason: z.string().nullable(),
    })
    .nullable(),
});

/** The fault a refused creation is answered with. */
function refusal(
  outcome: Extract<BureauGoalCreateOutcome, { outcome: 'rejected' }>,
  agentName: string,
): OperationFault {
  switch (outcome.code) {
    case 'durable-unavailable':
      return {
        code: 'UnsupportedCapability',
        message: outcome.reason,
        data: { capability: 'durable-goals' },
      };
    case 'shutdown':
      return { code: 'Unavailable', message: outcome.reason, data: { reason: 'shutdown' } };
    case 'agent-not-found':
      return resourceNotFound('agent', agentName);
    case 'invalid-configuration':
    case 'invalid-goal-run-id':
    case 'objective-too-large':
      return {
        code: 'InvalidParams',
        message: outcome.reason,
        data: { issues: [{ path: ['goal'], message: outcome.reason, code: 'custom' }] },
      };
    case 'record-unreadable':
      return {
        code: 'Unavailable',
        message: outcome.reason,
        data: { reason: 'goal-record-unreadable' },
      };
    default:
      return { code: 'Unprocessable', message: outcome.reason, data: { reason: outcome.code } };
  }
}

export const goalsCreateOperation = defineOperation<
  typeof createInput,
  typeof createOutput,
  BureauGoalsOperationHost
>({
  name: 'bureau.goals.create',
  mcpExposable: false,
  summary: 'Create a goal',
  description:
    'Creates a durable goal that runs the catalog agent `agentName` on `prompt` until the validator named by `validator` passes, within `bounds`. The caller owns it, so no scope is needed. `idempotencyKey` makes the call idempotent for the caller: the same request under the same key answers `existing`, and a different request under it is a `Conflict`. The goal’s id is derived from the key and the caller, so a key can never meet another owner’s goal. An agent that is not in the catalog is `NotFound`; a validator the Bureau lacks, or an agent that cannot run durably, is `Unprocessable` (`data.reason` says which); a bound or policy the goal rules refuse is `InvalidParams`. The `fresh-from-artifact` conversation policy is not offered here.',
  destructive: true,
  tags: ['Goals'],
  inputSchema: createInput,
  outputSchema: createOutput,
  producibleFaults: [
    'InvalidParams',
    'Forbidden',
    'NotFound',
    'Conflict',
    'Unprocessable',
    'Unavailable',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const owner = ownerOfPrincipal(principal);
    if (owner === undefined) {
      throw {
        code: 'Forbidden',
        message: 'A goal needs an owner, and this credential names none',
        data: { reason: 'no owner of record' },
      } satisfies OperationFault;
    }
    const { bounds } = input;
    const outcome = await host.goals.create({
      agentName: input.agentName,
      prompt: input.prompt,
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      identity: input.identity,
      validator: input.validator,
      bounds: {
        maximumAttempts: bounds.maximumAttempts,
        ...(bounds.maximumTotalDurationMs === undefined
          ? {}
          : { maximumTotalDurationMs: bounds.maximumTotalDurationMs }),
        ...(bounds.maximumTotalSteps === undefined
          ? {}
          : { maximumTotalSteps: bounds.maximumTotalSteps }),
        ...(bounds.maximumTotalTokens === undefined
          ? {}
          : { maximumTotalTokens: bounds.maximumTotalTokens }),
        ...(bounds.maximumTotalCostUsd === undefined
          ? {}
          : { maximumTotalCostUsd: bounds.maximumTotalCostUsd }),
      },
      ...(input.conversationPolicy === undefined
        ? {}
        : { conversationPolicy: input.conversationPolicy }),
      ...(input.retryPolicy === undefined ? {} : { retryPolicy: input.retryPolicy }),
      ...(input.validatorTimeoutMs === undefined
        ? {}
        : { validatorTimeoutMs: input.validatorTimeoutMs }),
      ...(input.requireDeterministicValidation === undefined
        ? {}
        : { requireDeterministicValidation: input.requireDeterministicValidation }),
      ...(input.idempotencyKey === undefined
        ? {}
        : { goalRunId: goalRunIdFor(owner, input.idempotencyKey) }),
      principal: owner,
    });
    switch (outcome.outcome) {
      case 'created':
      case 'existing': {
        const { controller } = outcome;
        return {
          outcome: outcome.outcome,
          goal: viewOf(outcome.goal),
          controller:
            controller === undefined
              ? null
              : {
                  status: controller.status,
                  reason: controller.status === 'start-failed' ? controller.reason : null,
                },
        };
      }
      case 'conflict':
        throw {
          code: 'Conflict',
          message: 'A goal with this id already exists and is not this request',
          data: { reason: 'goal-run-id-taken' },
        } satisfies OperationFault;
      case 'rejected':
        throw refusal(outcome, input.agentName);
    }
  },
});

const cancelInput = z.object({
  goalRunId: goalIdentifier,
  reason: z.string().max(1_000).optional(),
  expectedRevision: z.number().int().min(0).optional(),
});

const cancelOutput = z.object({
  goalRunId: z.string(),
  /**
   * `canceled`: the goal, its controller, and its attempt’s run are read back as stopped.
   * `cancellation-pending`: the cancellation is recorded and will finish; cancel again, or read
   * the goal. `already-terminal`: the goal had ended for another reason. `contended`: the
   * cancellation could not be recorded against concurrent writers; call again.
   */
  outcome: z.enum(['canceled', 'cancellation-pending', 'already-terminal', 'contended']),
  status: goalStatus,
  /** The goal’s revision after the call, for the next `expectedRevision`. */
  revision: z.number().int(),
});

export const goalsCancelOperation = defineOperation<
  typeof cancelInput,
  typeof cancelOutput,
  BureauGoalsOperationHost
>({
  name: 'bureau.goals.cancel',
  mcpExposable: false,
  summary: 'Cancel a goal',
  description:
    'Cancels one of the caller’s own goals; a caller holding `bureau.goals:write` cancels any owner’s, and anyone else is answered `NotFound`. The goal’s controller and its attempt’s run are stopped, and the receipt’s `outcome` says how far that has got: it is an answer about durable state read back, never about a request merely sent. `expectedRevision`, when given, is compared inside the store’s compare-and-swap that records the cancellation: a goal that has changed since is a `StaleRevision` fault whose `currentRevision` is the revision now current, and nothing is written. The write scope does not imply the read scope, so the receipt carries the status and revision and nothing else of the goal. A repeated cancel has the same effect.',
  destructive: true,
  tags: ['Goals'],
  inputSchema: cancelInput,
  outputSchema: cancelOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'StaleRevision', 'Unavailable'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    await goalFor(host, principal, input.goalRunId, 'bureau.goals:write');
    // The predicate has decided who may cancel, so the Bureau's trusted call is used.
    const outcome = await host.goals.cancel(input.goalRunId, {
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    });
    switch (outcome.outcome) {
      case 'not-found':
        throw resourceNotFound('goal', input.goalRunId);
      case 'record-unreadable':
        throw {
          code: 'Unavailable',
          message: `The record of goal "${input.goalRunId}" cannot be read`,
          data: { reason: 'goal-record-unreadable' },
        } satisfies OperationFault;
      case 'stale-revision':
        throw {
          code: 'StaleRevision',
          message: `Goal "${input.goalRunId}" is at revision ${outcome.goal.revision}, not the expected revision ${String(input.expectedRevision)}`,
          data: {
            ...(input.expectedRevision === undefined
              ? {}
              : { expectedRevision: input.expectedRevision }),
            currentRevision: outcome.goal.revision,
          },
        } satisfies OperationFault;
      default:
        return {
          goalRunId: input.goalRunId,
          outcome: outcome.outcome,
          status: outcome.goal.status,
          revision: outcome.goal.revision,
        };
    }
  },
});

/** The goal operations, in the order the handler serves them. */
export const bureauGoalsOperations = [
  goalsListOperation,
  goalsGetOperation,
  goalsCreateOperation,
  goalsCancelOperation,
] as const;
