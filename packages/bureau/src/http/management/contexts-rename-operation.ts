/**
 * `bureau.contexts.rename`: give a context (a Bureau session) a title, or take the one it was given
 * away, through `Bureau.contexts.rename` (COR-1909).
 *
 * A context's `title` is, until it is renamed, the first message a person sent it. A rename stores
 * a title of the caller's choosing in the session's metadata, and every summary shows it in place
 * of the derived one until it is cleared. Authorization is the delete operation's: the owner, or a
 * caller holding `bureau.contexts:write`, and anyone else is answered as for a missing context.
 *
 * @module contexts-rename-operation
 */

import {
  SESSION_TITLE_OVERRIDE_LIMIT,
  sessionOwnerOf,
  summarizeSession,
} from '@lostgradient/operative';
import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import { BureauError, BureauShuttingDownError } from '../../create-bureau.ts';
import type { TaskRegistry } from '../../task-registry.ts';
import type { BureauContexts, BureauInternals } from '../../types.ts';
import { type BureauOwnershipHost } from '../owner-predicate.ts';
import { contextSummarySchema, noSessions, projectContext } from './contexts-operations.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.contexts.rename` reads from the handler's `host`. */
export type BureauContextsRenameOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'rename'> & {
    readonly internals: Pick<BureauInternals, 'sessionStore'>;
  };
  readonly tasks: Pick<TaskRegistry, 'activityOf'>;
};

const contextsRenameInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context to rename.'),
  title: z
    .string()
    .max(SESSION_TITLE_OVERRIDE_LIMIT)
    .refine((title) => title.trim() !== '', 'title must not be blank')
    .nullable()
    .describe(
      'The new title, trimmed, 1 to 200 characters; or `null` to remove the title and show the one derived from the first message again.',
    ),
});

export const contextsRenameOperation = defineOperation<
  typeof contextsRenameInput,
  typeof contextSummarySchema,
  BureauContextsRenameOperationHost
>({
  name: 'bureau.contexts.rename',
  mcpExposable: false,
  summary: 'Rename a context',
  description:
    'Gives one of the caller’s own contexts a `title`, which `bureau.contexts.list` and `get` show in place of the one derived from its first message, and which `titleContains` matches; a caller holding `bureau.contexts:write` renames any owner’s. `title: null` removes it, and the derived title returns. A rename is not activity: the context’s `updatedAt`, and so its place in a listing, does not move. Setting the title a context already has is not an error, so a retry is safe. A blank title and one over 200 characters are `InvalidParams`. Another owner’s context and a missing one answer `NotFound`. A Bureau that is shutting down is `Unavailable` with reason `shutting-down`. Answers the renamed context’s summary. The call writes no audit entry.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: contextsRenameInput,
  outputSchema: contextSummarySchema,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability', 'Unavailable'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { contextId } = input;
    if (host.contexts.internals.sessionStore === undefined) throw noSessions();
    // The one session loaded here is the one authorized and the one renamed.
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
    let renamed;
    try {
      renamed = await host.contexts.rename(contextId, input.title, {
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
      if (error instanceof BureauError && error.code === 'BAD_REQUEST') {
        throw {
          code: 'InvalidParams',
          message: error.message,
          data: { issues: [{ path: ['title'], message: error.message, code: 'custom' }] },
        } satisfies OperationFault;
      }
      throw error;
    }
    // The id holds another incarnation now (or none): the context authorized is gone.
    if (renamed === undefined) throw resourceNotFound('context', contextId);
    const activity = await host.tasks.activityOf(
      [contextId],
      new Map([[contextId, renamed.incarnation]]),
    );
    return projectContext(summarizeSession(renamed), activity.get(contextId));
  },
});
