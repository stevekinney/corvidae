import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.contexts.resumeturn`: let a context's last stopped turn go on, through
 * `Bureau.contexts.resumeTurn` (COR-2437). A continuation run starts on the stored conversation,
 * the partial reply included, with no message from the person, and writes a new assistant turn
 * after the partial reply. A `commandId` makes the call idempotent: a retry answers the run the
 * first call started, after a restart too, and never starts a second.
 *
 * | Refusal                                         | Fault         | `data.reason`                       |
 * | ----------------------------------------------- | ------------- | ----------------------------------- |
 * | a missing or invisible context                  | `NotFound`    | none (`data.resource` is `context`) |
 * | a run the context does not have                 | `NotFound`    | none (`data.resource` is `run`)     |
 * | a later run, or the turn already went on        | `Conflict`    | `not-latest-turn`                   |
 * | the run is still going                          | `Conflict`    | `turn-running`                      |
 * | the run waits on an approval or a question      | `Conflict`    | `turn-awaiting-person`              |
 * | the run's process stopped; boot recovery has it | `Conflict`    | `turn-recovering`                   |
 * | the run finished, or hit its token limit        | `Conflict`    | `turn-finished`                     |
 * | the run failed on a cause it would meet again   | `Conflict`    | `run-not-resumable`                 |
 * | the turn stopped inside a tool call             | `Conflict`    | `turn-interrupted-call`             |
 * | a follow-up was delivered into the turn         | `Conflict`    | `follow-up-delivered`               |
 * | a follow-up is still queued                     | `Conflict`    | `follow-ups-queued`                 |
 * | the run wrote nothing, or was discarded         | `Conflict`    | `nothing-to-resume`                 |
 * | the `commandId` resumed another run             | `Conflict`    | `command-conflict`                  |
 * | the context is archived                         | `Conflict`    | `context-archived`                  |
 * | Bureau is shutting down                         | `Unavailable` | `shutting-down`                     |
 *
 * It needs both `bureau.contexts:read` and `bureau.contexts:write` for another owner's context,
 * as discarding a turn does, and none for the caller's own. The continuation run is the caller's.
 *
 * @module contexts-resume-turn-operation
 */

import { sessionOwnerOf } from '@lostgradient/operative';
import { defineOperation, type OperationFault } from '@lostgradient/backchannel';
import { z } from 'zod';

import { BureauError, BureauShuttingDownError, ContextArchivedError } from '../../bureau-errors.ts';
import { contextArchivedFault } from './contexts-archive-operation.ts';
import { SessionResumeRefusedError } from '../../session-resume.ts';
import type { BureauContexts } from '../../bureau-types/contexts.ts';
import type { BureauInternals } from '../../bureau-types/facade.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.contexts.resumeturn` reads from the handler's `host`. */
export type BureauContextsResumeTurnOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'resumeTurn'> & {
    readonly internals: Pick<BureauInternals, 'sessionStore'>;
  };
};

const contextsResumeTurnInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context whose turn to resume.'),
  commandId: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'The caller’s own identifier for the command; a retry of it answers the run the first call started.',
    ),
  runId: z
    .string()
    .min(1)
    .describe(
      'The run whose turn to resume: the context’s last run, which the person stopped or which failed.',
    ),
});

const contextsResumeTurnOutput = z.object({
  /** The context whose turn went on. */
  contextId: z.string(),
  /** The continuation run, which goes on from the stopped run's partial reply. */
  runId: z.string(),
  /** The stopped run whose turn went on. */
  resumedRunId: z.string(),
});

export const contextsResumeTurnOperation = defineOperation<
  typeof contextsResumeTurnInput,
  typeof contextsResumeTurnOutput,
  BureauContextsResumeTurnOperationHost
>({
  name: 'bureau.contexts.resumeturn',
  authorize: authorizeWorkspaceOperation('bureau.contexts.resumeturn'),
  mcpExposable: false,
  summary: 'Resume a context’s last stopped turn',
  description:
    'Lets the last stopped turn of one of the caller’s own contexts go on. A continuation run starts on the stored conversation, the partial reply included, with no message from the person, and writes a new assistant turn after the partial reply; the answer names it as `runId`, and the stopped run as `resumedRunId`. `runId` must be the context’s last run, stopped by the person or failed on a cause worth trying again (finish reason `error`). The start is one atomic write to the context that adds a hidden continuation row naming the stopped run and the command and judges the history again, so a message, a discard or another resume that lands first wins and this one is refused. `commandId` is the caller’s own identifier: a retry answers the run the first call started, after a restart too, and never starts a second; the same `commandId` for another run is a `Conflict` with reason `command-conflict`. Each refusal is a `Conflict` and starts nothing: `not-latest-turn` (a later run, or the turn already went on), `turn-running`, `turn-awaiting-person` (it goes on once the approval or question is answered), `turn-recovering` (the run’s process stopped, and the Bureau that next boots goes on with it from its checkpoint or ends it when it cannot), `turn-finished` (a reply cut at the token limit included), `run-not-resumable` (a failure going on would meet again), `turn-interrupted-call` (the turn stopped inside a tool call, which going on would run again unasked), `follow-up-delivered`, `follow-ups-queued` and `nothing-to-resume`. A run the context does not have is `NotFound`. An archived context is a `Conflict` with reason `context-archived`. A Bureau that is shutting down is `Unavailable` with reason `shutting-down`. Another owner’s context and a missing one answer `NotFound`, whatever run they name; another owner’s needs both `bureau.contexts:read` and `bureau.contexts:write`. No scope is needed for the caller’s own.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: contextsResumeTurnInput,
  outputSchema: contextsResumeTurnOutput,
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
        message: 'This Bureau keeps no sessions, so it has no turns to resume',
        data: { capability: 'session-store' },
      } satisfies OperationFault;
    }
    const owner = ownerOfPrincipal(principal);
    // Authorized before anything about the run is read, as discarding a turn is.
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
      const result = await host.contexts.resumeTurn(contextId, {
        owner,
        commandId: input.commandId,
        runId: input.runId,
      });
      return {
        contextId: result.contextId,
        runId: result.runId,
        resumedRunId: result.resumedRunId,
      };
    } catch (error) {
      if (error instanceof SessionResumeRefusedError) {
        if (error.reason === 'run-not-found') throw resourceNotFound('run', input.runId);
        throw {
          code: 'Conflict',
          message: error.message,
          data: { reason: error.reason },
        } satisfies OperationFault;
      }
      if (error instanceof ContextArchivedError) throw contextArchivedFault(error.message);
      if (error instanceof BureauShuttingDownError) {
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
