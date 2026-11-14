import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.contexts.archive`: archive a context (a Bureau session) through `Bureau.contexts.archive`
 * (COR-2285).
 *
 * An archived context accepts no new work: a task started in it, `bureau.contexts.input`,
 * `bureau.contexts.steer` and `bureau.contexts.regenerate` are refused with a `Conflict` whose
 * `data.reason` is `context-archived`, until `bureau.contexts.unarchive`. Authorization is the
 * rename operation's: the owner, or a caller holding `bureau.contexts:write`, and anyone else is
 * answered as for a missing context. The answer is a receipt, never the context's summary, for the
 * same reason a rename's is: `bureau.contexts:write` does not imply `bureau.contexts:read`.
 *
 * @module contexts-archive-operation
 */

import { sessionOwnerOf } from '@lostgradient/operative';
import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import { BureauShuttingDownError, ContextBusyError } from '../../bureau-errors.ts';
import type { BureauContexts } from '../../bureau-types/contexts.ts';
import type { BureauInternals } from '../../bureau-types/facade.ts';
import { type BureauOwnershipHost } from '../owner-predicate.ts';
import { noSessions } from './contexts-operations.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.contexts.archive` reads from the handler's `host`. */
export type BureauContextsArchiveOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'archive'> & {
    readonly internals: Pick<BureauInternals, 'sessionStore'>;
  };
};

const contextsArchiveInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context to archive.'),
});

/**
 * What `bureau.contexts.archive` and `bureau.contexts.unarchive` answer with: the context's
 * identifier, whether the call changed it, and when it was archived (`null` once it is not).
 */
export const contextArchiveReceiptSchema = z.object({
  id: z.string(),
  /** Whether this call changed the context: `false` for one that was already as asked. */
  changed: z.boolean(),
  /** When the context was archived, as an ISO 8601 timestamp, or `null` when it is not archived. */
  archivedAt: z.string().nullable(),
});

/**
 * The fault for new work refused because its context is archived: a `Conflict`, which a missing
 * context never is, with the stable reason `context-archived`.
 */
export function contextArchivedFault(message: string): OperationFault {
  return { code: 'Conflict', message, data: { reason: 'context-archived' } };
}

/** The fault for an archive refused because the context has a live task. */
export function contextBusyFault(message: string): OperationFault {
  return { code: 'Conflict', message, data: { reason: 'context-busy' } };
}

/** The fault for an archive, or an unarchive, refused because Bureau is shutting down. */
export function shuttingDownFault(message: string): OperationFault {
  return { code: 'Unavailable', message, data: { reason: 'shutting-down' } };
}

export const contextsArchiveOperation = defineOperation<
  typeof contextsArchiveInput,
  typeof contextArchiveReceiptSchema,
  BureauContextsArchiveOperationHost
>({
  name: 'bureau.contexts.archive',
  authorize: authorizeWorkspaceOperation('bureau.contexts.archive'),
  mcpExposable: false,
  summary: 'Archive a context',
  description:
    'Archives one of the caller’s own contexts; a caller holding `bureau.contexts:write` archives any owner’s. An archived context accepts no new work: starting a task in it, `bureau.contexts.input`, `bureau.contexts.steer` and `bureau.contexts.regenerate` are each a `Conflict` with reason `context-archived` until it is unarchived (`bureau.contexts.unarchive`); reading, renaming, deleting, forking, forgetting grants and the window keep working. `bureau.contexts.list` and `get` show when in `archivedAt`, and `list` filters by it with `archived`. A context with a task running, or waiting on an approval or an answer, is a `Conflict` with reason `context-busy`, and nothing is stored: stop or answer the task first. Archiving is not activity: the context’s `updatedAt`, and so its place in a listing, does not move. Archiving an archived context is not an error: it answers `changed: false` with the time it was first archived, so a retry is safe. Another owner’s context and a missing one answer `NotFound`. A Bureau that is shutting down is `Unavailable` with reason `shutting-down`. Answers a receipt, `{ id, changed, archivedAt }`, and nothing else of the context. The call writes no audit entry.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: contextsArchiveInput,
  outputSchema: contextArchiveReceiptSchema,
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
    if (host.contexts.internals.sessionStore === undefined) throw noSessions();
    // The one session loaded here is the one authorized and the one archived.
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
      outcome = await host.contexts.archive(contextId, { incarnation: session.incarnation });
    } catch (error) {
      if (error instanceof BureauShuttingDownError) throw shuttingDownFault(error.message);
      if (error instanceof ContextBusyError) throw contextBusyFault(error.message);
      throw error;
    }
    // The id holds another incarnation now (or none): the context authorized is gone.
    if (outcome === undefined) throw resourceNotFound('context', contextId);
    return { id: contextId, changed: outcome.changed, archivedAt: outcome.archivedAt };
  },
});
