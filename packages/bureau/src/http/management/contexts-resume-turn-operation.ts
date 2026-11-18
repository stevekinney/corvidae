import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.contexts.resumeturn`: let a context's last stopped turn go on, through
 * `Bureau.contexts.resumeTurn` (COR-2437). The run itself would go on from where it stopped, its
 * reply so far kept, with no new message from the person. No kind of stop can be resumed today,
 * so every call is refused with a named fault and a stable `data.reason`, and nothing is started
 * or written:
 *
 * | Refusal                                         | Fault      | `data.reason`                       |
 * | ----------------------------------------------- | ---------- | ----------------------------------- |
 * | a missing or invisible context                  | `NotFound` | none (`data.resource` is `context`) |
 * | a run the context does not have                 | `NotFound` | none (`data.resource` is `run`)     |
 * | a later run of the context                      | `Conflict` | `not-latest-turn`                   |
 * | the run is still going                          | `Conflict` | `turn-running`                      |
 * | the run waits on an approval or a question      | `Conflict` | `turn-awaiting-person`              |
 * | the run's process stopped; Bureau recovers it   | `Conflict` | `turn-recovering`                   |
 * | the run finished, or hit its token limit        | `Conflict` | `turn-finished`                     |
 * | the person stopped the run, or it failed        | `Conflict` | `run-not-resumable`                 |
 * | the context is archived                         | `Conflict` | `context-archived`                  |
 * | Bureau is shutting down                         | `Unavailable` | `shutting-down`                  |
 *
 * It needs both `bureau.contexts:read` and `bureau.contexts:write` for another owner's context,
 * as discarding a turn does, and none for the caller's own.
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
    .describe('The caller’s own identifier for the command; a retry of it is answered the same.'),
  runId: z
    .string()
    .min(1)
    .describe('The run whose turn to resume: the context’s last run, which stopped.'),
});

const contextsResumeTurnOutput = z.object({
  /** The context whose turn went on. */
  contextId: z.string(),
  /** The run that went on. */
  runId: z.string(),
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
    'Lets the last stopped turn of one of the caller’s own contexts go on: the run itself, from where it stopped, its reply so far kept, with no new message from the person. No kind of stop can be resumed yet, so every call is refused and nothing is started or written. A run the person stopped, or that failed, has ended its workflow, and the engine cannot go on with the same run: a `Conflict` with reason `run-not-resumable`. A run whose process stopped is recovered by the Bureau itself from where it was: `turn-recovering`. A reply the model cut at its token limit is a finished turn: `turn-finished`. A run still going is `turn-running`, and one waiting on an approval or a question `turn-awaiting-person`, which goes on once it is answered. A later run of the context is `not-latest-turn`, and a run the context does not have is `NotFound`. An archived context is a `Conflict` with reason `context-archived`. A Bureau that is shutting down is `Unavailable` with reason `shutting-down`. Another owner’s context and a missing one answer `NotFound`, whatever run they name; another owner’s needs both `bureau.contexts:read` and `bureau.contexts:write`. No scope is needed for the caller’s own.',
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
      return { contextId: result.contextId, runId: result.runId };
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
