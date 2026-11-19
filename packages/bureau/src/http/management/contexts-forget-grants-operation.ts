/**
 * `bureau.contexts.forgetgrants`: forget the "Allow for the rest of this chat" grant of each tool
 * named, in one of the caller's own contexts (B06, row 20c). Retry on a reply that failed sends a
 * new turn over a thread that still holds the failed attempt, so the tool the run was interrupted
 * on goes back through its approval instead of running a second time unasked. No row of the
 * conversation is removed: the failed attempt stays on record.
 *
 * A missing context and another owner's answer `NotFound` alike. A Bureau that keeps no sessions
 * is `UnsupportedCapability`, and one that is shutting down is `Unavailable` with reason
 * `shutting-down`. A caller reaches its own contexts without a scope and `bureau.contexts:write`
 * is the operator scope, as for `bureau.contexts.rename`.
 *
 * @module contexts-forget-grants-operation
 */

import { sessionOwnerOf } from '@lostgradient/operative';
import { defineOperation, type OperationFault } from '@lostgradient/backchannel';
import { z } from 'zod';

import { BureauShuttingDownError } from '../../bureau-errors.ts';
import type { BureauContexts } from '../../bureau-types/contexts.ts';
import type { Bureau, BureauInternals } from '../../bureau-types/facade.ts';
import { withoutGrantsFor } from '../../session-grants.ts';
import { type BureauOwnershipHost } from '../owner-predicate.ts';
import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';
import { noSessions } from './contexts-operations.ts';
import { dryRunField, dryRunResult, effect, orDryRun } from './dry-run.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.contexts.forgetgrants` reads from the handler's `host`. */
export type BureauContextsForgetGrantsOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'forgetGrants'> &
    Pick<Bureau, 'lifecycle'> & {
      readonly internals: Pick<BureauInternals, 'sessionStore'>;
    };
};

const contextsForgetGrantsInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context whose grants to forget.'),
  tools: z
    .array(z.string().min(1).max(256))
    .min(1)
    .max(32)
    .describe(
      'The names of the tools whose "Allow for the rest of this chat" grant the context forgets, as a tool call carries them (`namespace__name`, `namespace:name`, or a bare name in the default namespace); each matches every version of its tool, and no other namespace’s tool of that name.',
    ),
  dryRun: dryRunField,
});

const contextsForgetGrantsOutput = z.object({
  /** The grants forgotten, as the context stored them; empty when none matched. */
  forgotten: z.array(z.string()),
});

const contextsForgetGrantsAnswer = orDryRun(contextsForgetGrantsOutput);

/** The fault of a call refused because Bureau has closed admission, for the call and its dry run. */
function shuttingDownFault(message: string): OperationFault {
  return { code: 'Unavailable', message, data: { reason: 'shutting-down' } };
}

export const contextsForgetGrantsOperation = defineOperation<
  typeof contextsForgetGrantsInput,
  typeof contextsForgetGrantsAnswer,
  BureauContextsForgetGrantsOperationHost
>({
  name: 'bureau.contexts.forgetgrants',
  authorize: authorizeWorkspaceOperation('bureau.contexts.forgetgrants'),
  mcpExposable: false,
  supportsDryRun: true,
  summary: 'Forget a context’s remembered tool grants',
  description:
    'Forgets the “Allow for the rest of this chat” grant of each tool named in `tools`, in one of the caller’s own contexts, so the next call of that tool asks for approval again; a caller holding `bureau.contexts:write` reaches any owner’s. A name is read as the name a provider calls the tool by, as a stored call carries it (`shop__issue-refund`) or as a result reports it (`shop:issue-refund`), and matches the grants of every version of that tool; a name no grant matches changes nothing, so a retry is safe. Nothing else of the context changes: no row of its conversation is removed, and its `updatedAt` does not move. Answers `{ forgotten }`, the grants forgotten as they were stored. Another owner’s context and a missing one answer `NotFound`. A Bureau that keeps no sessions is `UnsupportedCapability`, and one that is shutting down is `Unavailable` with reason `shutting-down`. With `dryRun: true` nothing is forgotten: the answer is `{ dryRun: true, target, effects }`, whose `tool-grants` effect counts the grants the call would forget, and a context that is missing or not the caller’s, a Bureau that keeps no sessions, or one that is shutting down answers the fault the real call answers.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: contextsForgetGrantsInput,
  outputSchema: contextsForgetGrantsAnswer,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability', 'Unavailable'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { contextId } = input;
    if (host.contexts.internals.sessionStore === undefined) throw noSessions();
    // The one session loaded here is the one authorized and the one changed.
    const session = await host.contexts.get(contextId);
    if (
      session === undefined ||
      !host.ownership.mayAccess({
        principal,
        resourceOwner: sessionOwnerOf(session.metadata) ?? undefined,
        operatorScope: 'bureau.contexts:write',
      })
    ) {
      throw resourceNotFound('context', contextId);
    }
    if (input.dryRun === true) {
      // The refusal `forgetGrants` makes before it writes: a Bureau that has closed admission.
      if (host.contexts.lifecycle !== 'ready') {
        throw shuttingDownFault('Cannot forget grants: Bureau is shutting down.');
      }
      // The same match the call makes on the session it just loaded, with nothing written.
      const { forgotten: wouldForget } = withoutGrantsFor(session.metadata, input.tools);
      return dryRunResult({ kind: 'context-grants', id: contextId }, [
        effect('tool-grants', wouldForget.length),
      ]);
    }
    let forgotten;
    try {
      forgotten = await host.contexts.forgetGrants(contextId, input.tools, {
        incarnation: session.incarnation,
      });
    } catch (error) {
      if (error instanceof BureauShuttingDownError) throw shuttingDownFault(error.message);
      throw error;
    }
    // The id holds another incarnation now (or none): the context authorized is gone.
    if (forgotten === undefined) throw resourceNotFound('context', contextId);
    return { forgotten: [...forgotten] };
  },
});
