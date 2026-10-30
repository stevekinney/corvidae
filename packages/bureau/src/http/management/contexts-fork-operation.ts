/**
 * `bureau.contexts.fork`: branch a context (a Bureau session) at the end of a turn, or before its
 * first message, through `Bureau.contexts.fork` (COR-1560, COR-1910). Editing a sent message is a
 * fork at the reply before it, or `throughMessageId: null` for the first message, followed by a
 * new run of the edited text on the fork (`bureau.contexts.input` reaches only a live run, and an
 * idle fork answers it `session-terminal`); the original stays as history through `parentContextId`.
 *
 * The new context shares the history through `throughMessageId` (nothing, for `null`), is owned by
 * the caller, records
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
 * | not the last reply of an ended run     | `Conflict`    | `not-a-branch-point`                |
 * | a tool approval is still pending       | `Conflict`    | `branch-with-pending-approval`      |
 * | a tool call has no result              | `Conflict`    | `branch-with-unresolved-tool-call`  |
 * | the `commandId` named another message  | `Conflict`    | `command-conflict`                  |
 * | Bureau is shutting down                | `Unavailable` | `shutting-down`                     |
 *
 * Branching another owner's context copies its history, so it requires both `bureau.contexts:read`
 * and `bureau.contexts:write`; the call writes no audit entry.
 *
 * @module contexts-fork-operation
 */

import { ForkThroughMessageError, sessionOwnerOf } from '@lostgradient/operative';
import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import { BureauError, BureauShuttingDownError } from '../../create-bureau.ts';
import { SessionForkRefusedError } from '../../session-fork.ts';
import type { BureauContexts, BureauInternals } from '../../types.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import { projectSteeringOutcome, steeringOutcomeSchema } from './contexts-steer-operation.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.contexts.fork` reads from the handler's `host`. */
export type BureauContextsForkOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'fork'> & {
    readonly internals: Pick<BureauInternals, 'sessionStore'>;
  };
};

const contextsForkInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context to branch.'),
  commandId: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'The caller’s own identifier for the command; an exact retry of it returns the original answer.',
    ),
  throughMessageId: z
    .string()
    .min(1)
    .nullable()
    .describe(
      'The last assistant reply of a run that has ended in the context (completed, errored or aborted), which the branch ends at; null branches before the first message, so the new context starts empty.',
    ),
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
  /**
   * The outcome of admitting the parent's effort on the new context, as `<commandId>:effort`
   * (COR-1935); `null` when the parent had none. A refused admission leaves the new context in
   * place, on the effort its agent's request carries.
   */
  carriedEffort: steeringOutcomeSchema.nullable(),
  /**
   * The outcome of admitting the parent's permission mode on the new context, as
   * `<commandId>:permission-mode` (COR-1936); `null` when the parent had none. A refused admission
   * leaves the new context in place on `on-changes`.
   */
  carriedPermissionMode: steeringOutcomeSchema.nullable(),
});

/** The fault a refused branch answers with; a missing message is named by its identifier. */
function faultForRefusal(
  error: SessionForkRefusedError,
  throughMessageId: string | null,
): OperationFault {
  if (error.reason === 'message-not-found' && throughMessageId !== null) {
    return resourceNotFound('message', throughMessageId);
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
  summary: 'Branch a context at a reply or before its first message',
  description:
    'Branches one of the caller’s own contexts at the end of a turn: a new context that shares the history through `throughMessageId`, which must be the last assistant reply of a run that has ended (`completed`, errored or aborted), is owned by the caller, and records its lineage (`parentContextId`, `forkedFromMessageId`). `throughMessageId: null` branches before the first message: the new context starts empty, records `parentContextId` and a `null` `forkedFromMessageId`. Editing a sent message is this call at the reply before it, then a new run of the edited text on the new context (`bureau.contexts.input` reaches only a live run, so an idle fork answers it `session-terminal`); the original is left unchanged. An earlier turn can be branched while a later run of the context is still live; the live run’s own replies cannot. The parent’s latest model override is carried onto the new context as `<commandId>:model`, and its admission outcome is returned as `carriedOverride`, `null` when the parent had none; a refused admission (the model is no longer allowed) leaves the new context in place on the agent’s default. The parent’s effort is carried the same way as `<commandId>:effort` and returned as `carriedEffort`, and its permission mode as `<commandId>:permission-mode` and `carriedPermissionMode`, so a branch of a read-only chat is read-only. `commandId` is the caller’s own identifier: an exact retry, even after a restart, returns the original answer and creates nothing more. The command’s identity is the caller’s owner, the context and the `commandId`, so an operator and the owner retrying one `commandId` make two forks, and a settled command is kept for 24 hours, after which an exact retry branches again. A message the context does not hold is `NotFound`. A message that is not the last assistant reply of an ended run is a `Conflict` with reason `not-a-branch-point`; a run with a tool approval waiting `branch-with-pending-approval`; a reply with a tool call that has no result `branch-with-unresolved-tool-call`; and a `commandId` already used for another message `command-conflict`. A Bureau that is shutting down is `Unavailable` with reason `shutting-down`. Another owner’s context and a missing one answer `NotFound`. Branching another owner’s context copies its history, so it requires both `bureau.contexts:read` and `bureau.contexts:write`; a caller holding only one of them is answered `NotFound`, as for a context it may not see. No scope is needed for the caller’s own. The call writes no audit entry.',
  destructive: true,
  tags: ['Contexts'],
  inputSchema: contextsForkInput,
  outputSchema: contextsForkOutput,
  producibleFaults: [
    'InvalidParams',
    'NotFound',
    'Conflict',
    'UnsupportedCapability',
    'Unavailable',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { contextId } = input;
    if (host.contexts.internals.sessionStore === undefined) {
      throw {
        code: 'UnsupportedCapability',
        message: 'This Bureau keeps no sessions, so it has no contexts to branch',
        data: { capability: 'session-store' },
      } satisfies OperationFault;
    }
    const owner = ownerOfPrincipal(principal);
    // The one session loaded here is the one authorized and the one branched. A fork copies the
    // parent's history to its caller, so another owner's context needs the read scope as well as
    // the write scope: neither implies the other.
    const session = await host.contexts.get(contextId);
    const mayAct = (operatorScope: 'bureau.contexts:read' | 'bureau.contexts:write') =>
      session !== undefined &&
      host.ownership.mayAccess({
        principal,
        resourceOwner: sessionOwnerOf(session.metadata) ?? undefined,
        operatorScope,
      });
    if (
      owner === undefined ||
      session === undefined ||
      !mayAct('bureau.contexts:read') ||
      !mayAct('bureau.contexts:write')
    ) {
      throw resourceNotFound('context', contextId);
    }
    try {
      const result = await host.contexts.fork(contextId, {
        owner,
        commandId: input.commandId,
        throughMessageId: input.throughMessageId,
      });
      const carried = result.carriedOverride;
      if (carried !== null && carried.outcome === 'not-found') {
        throw new Error('The new context vanished before its override was admitted.');
      }
      const carriedEffort = result.carriedEffort ?? null;
      if (carriedEffort !== null && carriedEffort.outcome === 'not-found') {
        throw new Error('The new context vanished before its effort was admitted.');
      }
      const carriedPermissionMode = result.carriedPermissionMode ?? null;
      if (carriedPermissionMode !== null && carriedPermissionMode.outcome === 'not-found') {
        throw new Error('The new context vanished before its permission mode was admitted.');
      }
      return {
        contextId: result.contextId,
        carriedOverride: carried === null ? null : projectSteeringOutcome(carried),
        carriedEffort: carriedEffort === null ? null : projectSteeringOutcome(carriedEffort),
        carriedPermissionMode:
          carriedPermissionMode === null ? null : projectSteeringOutcome(carriedPermissionMode),
      };
    } catch (error) {
      if (error instanceof SessionForkRefusedError) {
        throw faultForRefusal(error, input.throughMessageId);
      }
      // Only a closed Bureau is `shutting-down`. Steering contention while the parent's override is
      // carried is not: it surfaces as an error, and the ledger lets an exact retry finish the fork.
      if (error instanceof BureauShuttingDownError) {
        throw {
          code: 'Unavailable',
          message: error.message,
          data: { reason: 'shutting-down' },
        } satisfies OperationFault;
      }
      if (error instanceof ForkThroughMessageError) {
        throw input.throughMessageId === null
          ? resourceNotFound('context', contextId)
          : resourceNotFound('message', input.throughMessageId);
      }
      if (error instanceof BureauError && error.code === 'NOT_FOUND') {
        throw resourceNotFound('context', contextId);
      }
      throw error;
    }
  },
});
