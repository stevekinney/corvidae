import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.contexts.unarchive`: unarchive a context (a Bureau session) through
 * `Bureau.contexts.unarchive` (COR-2285), so it accepts work again. Authorization is the archive
 * operation's, and the answer is the same receipt.
 *
 * @module contexts-unarchive-operation
 */

import { sessionOwnerOf } from '@lostgradient/operative';
import { defineOperation } from '@lostgradient/weft';
import { z } from 'zod';

import { BureauShuttingDownError } from '../../bureau-errors.ts';
import type { BureauContexts } from '../../bureau-types/contexts.ts';
import type { BureauInternals } from '../../bureau-types/facade.ts';
import { type BureauOwnershipHost } from '../owner-predicate.ts';
import { contextArchiveReceiptSchema, shuttingDownFault } from './contexts-archive-operation.ts';
import { noSessions } from './contexts-operations.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.contexts.unarchive` reads from the handler's `host`. */
export type BureauContextsUnarchiveOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'unarchive'> & {
    readonly internals: Pick<BureauInternals, 'sessionStore'>;
  };
};

const contextsUnarchiveInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context to unarchive.'),
});

export const contextsUnarchiveOperation = defineOperation<
  typeof contextsUnarchiveInput,
  typeof contextArchiveReceiptSchema,
  BureauContextsUnarchiveOperationHost
>({
  name: 'bureau.contexts.unarchive',
  authorize: authorizeWorkspaceOperation('bureau.contexts.unarchive'),
  mcpExposable: false,
  summary: 'Unarchive a context',
  description:
    'Unarchives one of the caller’s own contexts, so it accepts work again; a caller holding `bureau.contexts:write` unarchives any owner’s. Unarchiving is not activity: the context’s `updatedAt`, and so its place in a listing, does not move. Unarchiving a context that is not archived is not an error: it answers `changed: false`, so a retry is safe. Another owner’s context and a missing one answer `NotFound`. A Bureau that is shutting down is `Unavailable` with reason `shutting-down`. Answers a receipt, `{ id, changed, archivedAt }`, with `archivedAt: null`, and nothing else of the context. The call writes no audit entry.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: contextsUnarchiveInput,
  outputSchema: contextArchiveReceiptSchema,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability', 'Unavailable'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { contextId } = input;
    if (host.contexts.internals.sessionStore === undefined) throw noSessions();
    // The one session loaded here is the one authorized and the one unarchived.
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
    let outcome;
    try {
      outcome = await host.contexts.unarchive(contextId, { incarnation: session.incarnation });
    } catch (error) {
      if (error instanceof BureauShuttingDownError) throw shuttingDownFault(error.message);
      throw error;
    }
    // The id holds another incarnation now (or none): the context authorized is gone.
    if (outcome === undefined) throw resourceNotFound('context', contextId);
    return { id: contextId, changed: outcome.changed, archivedAt: outcome.archivedAt };
  },
});
