/**
 * `bureau.contexts.fork`: branch a context (a Bureau session) after a completed agent reply, through
 * `Bureau.forkSession` (COR-1560).
 *
 * The new context shares the history through `throughMessageId`, is owned by the caller, records
 * where it came from (`parentContextId` and `forkedFromMessageId`, which `bureau.contexts.list` and
 * `get` return), and keeps the parent's model: the parent's latest `model` override is admitted on
 * the new context as `<commandId>:model`, and that outcome is returned beside the `contextId`. A
 * `commandId` makes the call idempotent: an exact retry, even after a restart, returns the original
 * answer and creates nothing more.
 *
 * Each way a branch can be refused is a named fault with a stable `data.reason`, and nothing is
 * created:
 *
 * | Refusal                                | Fault         | `data.reason`                       |
 * | -------------------------------------- | ------------- | ----------------------------------- |
 * | a missing or invisible context         | `NotFound`    | none (`data.resource` is `context`) |
 * | a message the context does not hold    | `NotFound`    | none (`data.resource` is `message`) |
 * | not the final assistant reply of a run | `Conflict`    | `not-a-branch-point`                |
 * | the run ended in error                 | `Conflict`    | `branch-from-errored-run`           |
 * | the run was aborted                    | `Conflict`    | `branch-from-aborted-run`           |
 * | a tool approval is still pending       | `Conflict`    | `branch-with-pending-approval`      |
 * | a tool call has no result              | `Conflict`    | `branch-with-unresolved-tool-call`  |
 * | the `commandId` named another message  | `Conflict`    | `command-conflict`                  |
 * | Bureau is shutting down                | `Unavailable` | `shutting-down`                     |
 *
 * It requires `bureau.contexts:write` to branch another owner's context, and writes no audit entry.
 *
 * @module contexts-fork-operation
 */

import { sessionOwnerOf } from '@lostgradient/operative';
import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import { BureauError } from '../../create-bureau.ts';
import { SessionForkRefusedError } from '../../session-fork.ts';
import type { Bureau } from '../../types.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import { projectSteeringOutcome, steeringOutcomeSchema } from './contexts-steer-operation.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.contexts.fork` reads from the handler's `host`. */
export type BureauContextsForkOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<Bureau, 'getSession' | 'forkSession' | 'sessionStore'>;
};

const contextsForkInput = z.object({
  contextId: z.string().min(1),
  /** The caller's own identifier for the command; an exact retry of it returns the original answer. */
  commandId: z.string().min(1).max(256),
  /** The final assistant message of a completed run in the context, which the branch ends at. */
  throughMessageId: z.string().min(1),
});

const contextsForkOutput = z.object({
  /** The new context. */
  contextId: z.string(),
  /**
   * The outcome of admitting the parent's `model` override on the new context, as
   * `<commandId>:model`; `null` when the parent had none. A refused admission leaves the new
   * context in place, on the agent's default model.
   */
  carriedOverride: steeringOutcomeSchema.nullable(),
});

/** The fault a refused branch answers with. */
function faultForRefusal(error: SessionForkRefusedError): OperationFault {
  if (error.reason === 'message-not-found') {
    return resourceNotFound('message', error.message);
  }
  return { code: 'Conflict', message: error.message, data: { reason: error.reason } };
}

export const contextsForkOperation = defineOperation<
  typeof contextsForkInput,
  typeof contextsForkOutput,
  BureauContextsForkOperationHost
>({
  name: 'bureau.contexts.fork',
  mcpExposable: false,
  summary: 'Branch a context after a reply',
  description:
    'Branches one of the caller’s own contexts after a completed agent reply: a new context that shares the history through `throughMessageId`, which must be the final assistant message of a run that ended `completed`, is owned by the caller, and records its lineage (`parentContextId`, `forkedFromMessageId`). The parent’s latest model override is carried onto the new context as `<commandId>:model`, and its admission outcome is returned as `carriedOverride`, `null` when the parent had none; a refused admission (the model is no longer allowed) leaves the new context in place on the agent’s default. `commandId` is the caller’s own identifier: an exact retry, even after a restart, returns the original answer and creates nothing more. A message the context does not hold is `NotFound`. A message that is not the final assistant reply of a run is a `Conflict` with reason `not-a-branch-point`; a run that ended in error `branch-from-errored-run`; an aborted run `branch-from-aborted-run`; a run with a tool approval waiting `branch-with-pending-approval`; a reply with a tool call that has no result `branch-with-unresolved-tool-call`; and a `commandId` already used for another message `command-conflict`. A Bureau that is shutting down is `Unavailable` with reason `shutting-down`. Another owner’s context and a missing one answer `NotFound`. Requires `bureau.contexts:write` to branch another owner’s context; no scope is needed for the caller’s own. The call writes no audit entry.',
  destructive: true,
  tags: ['Contexts'],
  inputSchema: contextsForkInput,
  outputSchema: contextsForkOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'Conflict', 'UnsupportedCapability', 'Unavailable'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { contextId } = input;
    if (host.contexts.sessionStore === undefined) {
      throw {
        code: 'UnsupportedCapability',
        message: 'This Bureau keeps no sessions, so it has no contexts to branch',
        data: { capability: 'session-store' },
      } satisfies OperationFault;
    }
    const owner = ownerOfPrincipal(principal);
    // The one session loaded here is the one authorized and the one branched.
    const session = await host.contexts.getSession(contextId);
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
    try {
      const result = await host.contexts.forkSession(contextId, {
        owner,
        commandId: input.commandId,
        throughMessageId: input.throughMessageId,
      });
      const carried = result.carriedOverride;
      if (carried !== null && carried.outcome === 'not-found') {
        throw new Error('The new context vanished before its override was admitted.');
      }
      return {
        contextId: result.contextId,
        carriedOverride: carried === null ? null : projectSteeringOutcome(carried),
      };
    } catch (error) {
      if (error instanceof SessionForkRefusedError) throw faultForRefusal(error);
      if (error instanceof BureauError && error.code === 'CONFLICT') {
        throw {
          code: 'Unavailable',
          message: error.message,
          data: { reason: 'shutting-down' },
        } satisfies OperationFault;
      }
      if (error instanceof BureauError && error.code === 'NOT_FOUND') {
        throw resourceNotFound('context', contextId);
      }
      throw error;
    }
  },
});
