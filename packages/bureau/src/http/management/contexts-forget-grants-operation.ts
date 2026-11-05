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
import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import { BureauShuttingDownError } from '../../create-bureau.ts';
import type { BureauContexts, BureauInternals } from '../../types.ts';
import { type BureauOwnershipHost } from '../owner-predicate.ts';
import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';
import { noSessions } from './contexts-operations.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.contexts.forgetgrants` reads from the handler's `host`. */
export type BureauContextsForgetGrantsOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'forgetGrants'> & {
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
      'The names of the tools whose "Allow for the rest of this chat" grant the context forgets, as a tool call carries them; each matches every version of the tool.',
    ),
});

const contextsForgetGrantsOutput = z.object({
  /** The grants forgotten, as the context stored them; empty when none matched. */
  forgotten: z.array(z.string()),
});

export const contextsForgetGrantsOperation = defineOperation<
  typeof contextsForgetGrantsInput,
  typeof contextsForgetGrantsOutput,
  BureauContextsForgetGrantsOperationHost
>({
  name: 'bureau.contexts.forgetgrants',
  authorize: authorizeWorkspaceOperation('bureau.contexts.forgetgrants'),
  mcpExposable: false,
  summary: 'Forget a context’s remembered tool grants',
  description:
    'Forgets the “Allow for the rest of this chat” grant of each tool named in `tools`, in one of the caller’s own contexts, so the next call of that tool asks for approval again; a caller holding `bureau.contexts:write` reaches any owner’s. A name matches the grants of every version of the tool, and a name no grant matches changes nothing, so a retry is safe. Nothing else of the context changes: no row of its conversation is removed, and its `updatedAt` does not move. Answers `{ forgotten }`, the grants forgotten as they were stored. Another owner’s context and a missing one answer `NotFound`. A Bureau that keeps no sessions is `UnsupportedCapability`, and one that is shutting down is `Unavailable` with reason `shutting-down`.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: contextsForgetGrantsInput,
  outputSchema: contextsForgetGrantsOutput,
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
    let forgotten;
    try {
      forgotten = await host.contexts.forgetGrants(contextId, input.tools, {
        incarnation: session.incarnation,
      });
    } catch (error) {
      if (error instanceof BureauShuttingDownError) {
        throw {
          code: 'Unavailable',
          message: error.message,
          data: { reason: 'shutting-down' },
        } satisfies OperationFault;
      }
      throw error;
    }
    // The id holds another incarnation now (or none): the context authorized is gone.
    if (forgotten === undefined) throw resourceNotFound('context', contextId);
    return { forgotten: [...forgotten] };
  },
});
