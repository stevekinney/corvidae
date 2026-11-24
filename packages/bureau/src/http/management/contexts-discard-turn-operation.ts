import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.contexts.discardturn`: remove a context's last unfinished turn through
 * `Bureau.contexts.discardTurn` (COR-2437). The rows the run wrote after the person's message
 * (its replies, tool calls, tool results and the answers given to its questions) are removed, and
 * the person's message is kept. A `commandId` makes the call idempotent: an exact retry, even
 * after a restart, returns the original result and removes nothing more.
 *
 * Each way a discard can be refused is a named fault with a stable `data.reason`, and the history
 * is left as it was:
 *
 * | Refusal                                         | Fault         | `data.reason`                       |
 * | ----------------------------------------------- | ------------- | ----------------------------------- |
 * | a missing or invisible context                  | `NotFound`    | none (`data.resource` is `context`) |
 * | a run the context does not have                 | `NotFound`    | none (`data.resource` is `run`)     |
 * | a later run, or a row the run did not write     | `Conflict`    | `not-latest-turn`                   |
 * | the run is still going, or waits on a person    | `Conflict`    | `turn-running`                      |
 * | the run's process stopped before its end        | `Conflict`    | `turn-outcome-unknown`              |
 * | the run finished normally                       | `Conflict`    | `turn-finished`                     |
 * | a follow-up was delivered into the turn         | `Conflict`    | `follow-up-delivered`               |
 * | a follow-up is still queued                     | `Conflict`    | `follow-ups-queued`                 |
 * | the run wrote nothing                           | `Conflict`    | `nothing-to-discard`                |
 * | the context changed after it was read           | `Conflict`    | `history-changed`                   |
 * | the `commandId` named another run               | `Conflict`    | `command-conflict`                  |
 * | an earlier attempt is pending, no receipt       | `Conflict`    | `command-in-doubt`                  |
 * | the context is archived                         | `Conflict`    | `context-archived`                  |
 * | Bureau is shutting down                         | `Unavailable` | `shutting-down`                     |
 *
 * Only the chat owner may discard its turn. The removal's commit carries an audit entry,
 * `context.turn-discarded`, naming the run, the command and how many rows went, never a row's
 * text.
 *
 * @module contexts-discard-turn-operation
 */

import { sessionOwnerOf } from '@lostgradient/operative';
import { defineOperation, type OperationFault } from '@lostgradient/backchannel';
import { z } from 'zod';

import { ContextArchivedError } from '../../bureau-errors.ts';
import { contextArchivedFault } from './contexts-archive-operation.ts';
import { SessionDiscardRefusedError } from '../../session-discard.ts';
import type { BureauContexts } from '../../bureau-types/contexts.ts';
import type { BureauInternals } from '../../bureau-types/facade.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import { bureauFaultOf } from '../bureau-fault-policy.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.contexts.discardturn` reads from the handler's `host`. */
export type BureauContextsDiscardTurnOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'discardTurn'> & {
    readonly internals: Pick<BureauInternals, 'sessionStore'>;
  };
};

const contextsDiscardTurnInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context whose turn to discard.'),
  commandId: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'The caller’s own identifier for the command; an exact retry of it returns the original result and removes nothing more.',
    ),
  runId: z
    .string()
    .min(1)
    .describe(
      'The run whose turn to discard: the context’s last run, which the person stopped or which failed.',
    ),
});

const contextsDiscardTurnOutput = z.object({
  /** The context whose turn was discarded. */
  contextId: z.string(),
  /** The run whose turn was discarded. */
  runId: z.string(),
  /** How many rows the discard removed. */
  removed: z.number().int().nonnegative(),
  /** The context's revision once the removal was committed. */
  revision: z.number().int().nonnegative(),
});

/** The fault a refused discard answers with; a run the context does not have is `NotFound`. */
function faultForRefusal(error: SessionDiscardRefusedError, runId: string): OperationFault {
  if (error.reason === 'run-not-found') return resourceNotFound('run', runId);
  return { code: 'Conflict', message: error.message, data: { reason: error.reason } };
}

export const contextsDiscardTurnOperation = defineOperation<
  typeof contextsDiscardTurnInput,
  typeof contextsDiscardTurnOutput,
  BureauContextsDiscardTurnOperationHost
>({
  name: 'bureau.contexts.discardturn',
  authorize: authorizeWorkspaceOperation('bureau.contexts.discardturn'),
  mcpExposable: false,
  summary: 'Discard a context’s last unfinished turn',
  description:
    'Removes the last unfinished turn of one of the caller’s own contexts: the rows `runId` wrote after the person’s message that started it (its replies, tool calls, tool results and the answers given to its questions). The person’s message is kept. `runId` must be the context’s last run, and it must have ended without finishing: the person stopped it, or it failed. A run still going, or waiting on an approval or a question, is a `Conflict` with reason `turn-running` (cancel it first); one that finished normally is `turn-finished`; one whose process stopped before it recorded its end is `turn-outcome-unknown`; a later run or a row the run did not write after its turn is `not-latest-turn`; a follow-up the person sent that was delivered into the turn is `follow-up-delivered`, and one still queued is `follow-ups-queued`; a run that wrote nothing is `nothing-to-discard`. A run the context does not have is `NotFound`. The removal is one compare-and-swap on the context, fenced on the revision the call read: a change since then is a `Conflict` with reason `history-changed`, and nothing is written. The same commit records an audit entry, `context.turn-discarded`, with the run, the command and how many rows went. `commandId` is the caller’s own identifier: an exact retry, even after a restart, returns the original result and removes nothing more; a retry while the first call is still going is answered from that call’s committed receipt, or as a `Conflict` with reason `command-in-doubt`; the same `commandId` for another run is a `Conflict` with reason `command-conflict`. The run’s task is kept as it is: it still says how the run ended. An archived context is a `Conflict` with reason `context-archived`. A Bureau that is shutting down is `Unavailable` with reason `shutting-down`. Another owner’s context and a missing one answer `NotFound`; operator scopes never grant discard access to another owner’s chat.',
  destructive: true,
  tags: ['Contexts'],
  inputSchema: contextsDiscardTurnInput,
  outputSchema: contextsDiscardTurnOutput,
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
        message: 'This Bureau keeps no sessions, so it has no turns to discard',
        data: { capability: 'session-store' },
      } satisfies OperationFault;
    }
    const owner = ownerOfPrincipal(principal);
    // Authorized before anything about the run is read: a caller who may not act on the context
    // learns nothing of its runs, and a missing context answers as an invisible one.
    const session = await host.contexts.get(contextId);
    if (
      owner === undefined ||
      session === undefined ||
      sessionOwnerOf(session.metadata) !== owner
    ) {
      throw resourceNotFound('context', contextId);
    }
    try {
      const result = await host.contexts.discardTurn(contextId, {
        owner,
        commandId: input.commandId,
        runId: input.runId,
      });
      return {
        contextId: result.contextId,
        runId: result.runId,
        removed: result.removed,
        revision: result.revision,
      };
    } catch (error) {
      if (error instanceof SessionDiscardRefusedError) throw faultForRefusal(error, input.runId);
      if (error instanceof ContextArchivedError) throw contextArchivedFault(error.message);
      throw bureauFaultOf(error, { notFound: { resource: 'context', identifier: contextId } });
    }
  },
});
