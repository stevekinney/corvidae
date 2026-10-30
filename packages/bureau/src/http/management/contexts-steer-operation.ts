/**
 * `bureau.contexts.steer`: change one setting of a context (a Bureau session) through
 * `Bureau.contexts.steer` (COR-1559, COR-1935).
 *
 * A request names exactly one setting, as exactly one of its keys: `override` switches the model
 * to a model the agent allows, and `effort` sets the reasoning effort (`low`, `medium`, `high`,
 * `xhigh` or `max`). Another setting is another key of the same kind, so the input grows by a key
 * and not by a new operation. A request that names none, or more than one, is `InvalidParams`
 * naming the field.
 *
 * The model override is `{ provider, model }`, a catalog row's own coordinates. Bureau decides it
 * when it is admitted: a model the agent does not allow is refused then, with the reason
 * `model-not-allowed`, and no desired state changes. An effort no catalog row holds is refused
 * with `policy-denied`. Either is used from the context's live run's next step, and by every later
 * run of the context, across a restart; a context with no run in progress takes it for its next
 * run.
 *
 * The answer is Bureau's own admission outcome, as data, under its own names: `accepted`,
 * `replayed` (an exact retry of a `commandId`), `conflict` (the `commandId` was used for another
 * request), `rejected` with a `failure.reason` (`model-not-allowed`, `stale-revision` for an
 * `expectedRevision` behind the context's `configVersion`, `shutting-down`, or `policy-denied`),
 * and `unsupported-capability`. Only a context the caller cannot see, or a malformed request, is
 * a fault. Bureau admits steering only under the session's own authority, so an operator that is
 * not the owner is answered as for a missing context, as for `bureau.contexts.input`. The call
 * writes no audit entry.
 *
 * @module contexts-steer-operation
 */

import { type Effort, sessionOwnerOf, type SteeringRequestedValue } from '@lostgradient/operative';
import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import { BureauError, BureauShuttingDownError } from '../../create-bureau.ts';
import type { SteeringCommandAdmissionOutcome, SteeringCommandSnapshot } from '../../steering.ts';
import type { BureauContexts, BureauInternals } from '../../types.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.contexts.steer` reads from the handler's `host`. */
export type BureauContextsSteerOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'steer'> & {
    readonly internals: Pick<BureauInternals, 'sessionStore'>;
  };
};

/** The reasoning efforts a request may name, as Operative's `Effort` spells them. */
const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * The keys of {@link contextsSteerInput} that each name one setting to change. A request carries
 * exactly one of them; a later setting adds its key here and to the object below.
 */
const STEERED_SETTING_KEYS = ['override', 'effort'] as const;

const contextsSteerInput = z
  .object({
    contextId: z.string().min(1).describe('The identifier of the context to switch.'),
    commandId: z
      .string()
      .min(1)
      .max(256)
      .describe('The caller’s own identifier for the command; an exact retry of it is a replay.'),
    override: z
      .object({ provider: z.string().min(1), model: z.string().min(1) })
      .strict()
      .optional()
      .describe(
        'The catalog row to switch to: both coordinates, so a model name two providers serve is exact. Exactly one of `override` and `effort` is sent.',
      ),
    effort: effortSchema
      .optional()
      .describe(
        'The reasoning effort to set: `low`, `medium`, `high`, `xhigh` or `max`. Exactly one of `override` and `effort` is sent.',
      ),
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'The context’s `configVersion` (`bureau.contexts.get`) this command expects; a stale one is `stale-revision`.',
      ),
  })
  .superRefine((input, context) => {
    const named = STEERED_SETTING_KEYS.filter((key) => input[key] !== undefined);
    if (named.length === 1) return;
    // The issue is on the field the caller should change: the second one named, or the first one
    // that could have been.
    context.addIssue({
      code: 'custom',
      path: [named[1] ?? STEERED_SETTING_KEYS[0]],
      message:
        named.length === 0
          ? 'Exactly one of `override` and `effort` is required; none was sent'
          : 'Exactly one of `override` and `effort` is allowed; both were sent',
    });
  });

const failureSchema = z.object({
  failedAt: z.string(),
  reason: z.enum([
    'session-terminal',
    'run-terminal',
    'run-ambiguous',
    'authorization-revoked',
    'policy-denied',
    'model-not-allowed',
    'stale-revision',
    'shutting-down',
    'deadline-passed',
    'superseded-by',
  ]),
  supersededBy: z.string().optional(),
});

const commandSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  requestedValue: z.object({
    target: z.string(),
    override: z.string().optional(),
    provider: z.string().optional(),
    policyRef: z.string().optional(),
  }),
  runId: z.string().optional(),
  requestedAt: z.string(),
  state: z.enum(['requested', 'accepted', 'applied', 'rejected', 'superseded', 'failed']),
  configVersion: z.number().int().nonnegative(),
  failure: failureSchema.optional(),
});

/**
 * Bureau's steering admission outcomes, as the wire carries them. `not-found` is a fault, not an
 * outcome, so it is not here.
 */
export const steeringOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('accepted'), command: commandSchema }),
  z.object({ outcome: z.literal('replayed'), command: commandSchema }),
  z.object({
    outcome: z.literal('conflict'),
    conflict: z.object({
      id: z.string(),
      reason: z.enum(['session-mismatch', 'target-mismatch', 'requested-value-mismatch']),
      original: commandSchema,
    }),
  }),
  z.object({ outcome: z.literal('rejected'), failure: failureSchema }),
  z.object({ outcome: z.literal('session-terminal'), sessionId: z.string() }),
  z.object({ outcome: z.literal('unsupported-capability'), reason: z.string() }),
]);

function projectCommand(command: SteeringCommandSnapshot): z.infer<typeof commandSchema> {
  const { requestedValue, failure } = command;
  return {
    id: command.id,
    sessionId: command.sessionId,
    requestedValue: {
      target: requestedValue.target,
      ...('override' in requestedValue && requestedValue.override !== undefined
        ? { override: requestedValue.override }
        : {}),
      ...('provider' in requestedValue && requestedValue.provider !== undefined
        ? { provider: requestedValue.provider }
        : {}),
      ...('policyRef' in requestedValue && requestedValue.policyRef !== undefined
        ? { policyRef: requestedValue.policyRef }
        : {}),
    },
    ...(command.runId === undefined ? {} : { runId: command.runId }),
    requestedAt: command.requestedAt,
    state: command.state,
    configVersion: command.configVersion,
    ...(failure === undefined
      ? {}
      : {
          failure: {
            failedAt: failure.failedAt,
            reason: failure.reason,
            ...(failure.supersededBy === undefined ? {} : { supersededBy: failure.supersededBy }),
          },
        }),
  };
}

/** An admission outcome other than `not-found`, as the wire carries it. */
export function projectSteeringOutcome(
  outcome: Exclude<SteeringCommandAdmissionOutcome, { outcome: 'not-found' }>,
): z.infer<typeof steeringOutcomeSchema> {
  switch (outcome.outcome) {
    case 'accepted':
    case 'replayed':
      return { outcome: outcome.outcome, command: projectCommand(outcome.command) };
    case 'conflict':
      return {
        outcome: 'conflict',
        conflict: {
          id: outcome.conflict.id,
          reason: outcome.conflict.reason,
          original: projectCommand(outcome.conflict.original),
        },
      };
    case 'rejected':
      return {
        outcome: 'rejected',
        failure: {
          failedAt: outcome.failure.failedAt,
          reason: outcome.failure.reason,
          ...(outcome.failure.supersededBy === undefined
            ? {}
            : { supersededBy: outcome.failure.supersededBy }),
        },
      };
    case 'session-terminal':
      return { outcome: 'session-terminal', sessionId: outcome.sessionId };
    case 'unsupported-capability':
      return { outcome: 'unsupported-capability', reason: outcome.reason };
  }
}

export const contextsSteerOperation = defineOperation<
  typeof contextsSteerInput,
  typeof steeringOutcomeSchema,
  BureauContextsSteerOperationHost
>({
  name: 'bureau.contexts.steer',
  mcpExposable: false,
  summary: 'Switch a context’s model or effort',
  description:
    'Changes one setting of one of the caller’s own contexts; the request carries exactly one of `override` and `effort`, and one with none or both is `InvalidParams` naming the field. `override` (`{ provider, model }`) switches the context to a model, which must be one `bureau.agents.models` lists for the context’s agent. `effort` (`low`, `medium`, `high`, `xhigh` or `max`) sets the reasoning effort, which must be one the deployment’s model catalog holds, and `bureau.contexts.get` reads the settled one back. Either is used from the live run’s next step and by the context’s later runs, across a restart; a context with no run in progress takes it for its next run. `commandId` is the caller’s own identifier for the command, `expectedRevision` the `configVersion` (`bureau.contexts.get`) the caller read. The answer is Bureau’s admission outcome as data: `accepted` with the command and its `configVersion`; `replayed` for an exact retry of a `commandId`; `conflict` for a `commandId` used for another request; `rejected` with a `failure.reason`: `model-not-allowed` for a model the context’s agent does not allow (decided now, with nothing changed, and the same answer to every retry), `stale-revision` for an `expectedRevision` behind the context’s `configVersion`, `shutting-down` when Bureau is closing and nothing was decided (a retry after a restart is admitted normally), or `policy-denied` for a model or effort the deployment’s catalog does not hold; and `unsupported-capability` with its `reason`. Another owner’s context, a missing one, and an operator that does not own the context answer `NotFound`, since Bureau admits steering only under the session’s own authority. Requires `bureau.contexts:write` to act for any other owner; no scope is needed for the caller’s own. The call writes no audit entry.',
  destructive: true,
  tags: ['Contexts'],
  inputSchema: contextsSteerInput,
  outputSchema: steeringOutcomeSchema,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { contextId } = input;
    if (host.contexts.internals.sessionStore === undefined) {
      throw {
        code: 'UnsupportedCapability',
        message: 'This Bureau keeps no sessions, so it has no contexts to steer',
        data: { capability: 'session-store' },
      } satisfies OperationFault;
    }
    const owner = ownerOfPrincipal(principal);
    // The one session loaded here is the one authorized and the one the command is admitted to.
    const session = await host.contexts.get(contextId);
    if (
      owner === undefined ||
      session === undefined ||
      !host.ownership.mayAccess({
        principal,
        resourceOwner: sessionOwnerOf(session.metadata) ?? undefined,
        operatorScope: 'bureau.contexts:write',
      })
    ) {
      throw resourceNotFound('context', contextId);
    }
    // The schema holds that exactly one of the two is present.
    const { override, effort } = input;
    const requestedValue: SteeringRequestedValue =
      effort === undefined && override !== undefined
        ? { target: 'model', override: override.model, provider: override.provider }
        : { target: 'effort', override: effort as Effort };
    let outcome: SteeringCommandAdmissionOutcome;
    try {
      outcome = await host.contexts.steer(contextId, {
        id: input.commandId,
        principal: owner,
        requestedValue,
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
      });
    } catch (error) {
      // Bureau closed admission. Nothing was decided and nothing is logged, so a retry after a
      // restart is admitted as a new command; an in-process caller still gets the throw.
      if (error instanceof BureauShuttingDownError) {
        return {
          outcome: 'rejected' as const,
          failure: { failedAt: error.at, reason: 'shutting-down' as const },
        };
      }
      if (error instanceof BureauError && error.code === 'BAD_REQUEST') {
        throw {
          code: 'InvalidParams',
          message: error.message,
          data: {
            issues: [
              {
                path: [input.effort === undefined ? 'override' : 'effort'],
                message: error.message,
                code: 'custom',
              },
            ],
          },
        } satisfies OperationFault;
      }
      throw error;
    }
    if (outcome.outcome === 'not-found') throw resourceNotFound('context', contextId);
    return projectSteeringOutcome(outcome);
  },
});
