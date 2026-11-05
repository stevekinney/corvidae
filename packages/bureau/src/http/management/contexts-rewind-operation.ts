/**
 * `bureau.contexts.rewind`: take a turn back out of one of the caller's contexts so it can be sent
 * again, which is Retry on a reply that failed (B06, rows 19r and 20c). The conversation from
 * `fromMessageId` to its end is removed from the Bureau's own record, so the failed attempt is not
 * in the thread the next run reads and a thread read again does not bring it back, and the chat's
 * "Allow for the rest of this chat" grant is forgotten for each tool in `forgetGrantsFor`, so a
 * tool that changes things asks again instead of running a second time unasked.
 *
 * | Refusal                                | Fault      | `data.reason`                       |
 * | -------------------------------------- | ---------- | ----------------------------------- |
 * | a missing or invisible context         | `NotFound` | none (`data.resource` is `context`) |
 * | a row the context does not hold        | `NotFound` | none (`data.resource` is `message`) |
 * | a run is going or waits on an approval | `Conflict` | `run-in-progress`                   |
 *
 * Nothing is changed in a refusal. A Bureau that is shutting down is `Unavailable` with reason
 * `shutting-down`. A caller reaches its own contexts without a scope and `bureau.contexts:write`
 * is the operator scope, as for `bureau.contexts.input`.
 *
 * @module contexts-rewind-operation
 */

import { sessionOwnerOf } from '@lostgradient/operative';
import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import { BureauError } from '../../create-bureau.ts';
import type { BureauContexts, BureauInternals } from '../../types.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.contexts.rewind` reads from the handler's `host`. */
export type BureauContextsRewindOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'rewind'> & {
    readonly internals: Pick<BureauInternals, 'sessionStore'>;
  };
};

const contextsRewindInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context to rewind.'),
  fromMessageId: z.string().min(1).describe('The row to remove, with every row after it.'),
  forgetGrantsFor: z
    .array(z.string().min(1).max(256))
    .max(32)
    .optional()
    .describe(
      'The names of the tools whose "Allow for the rest of this chat" grant the context forgets.',
    ),
});

const contextsRewindOutput = z.object({
  /** The identifiers of the rows removed, in conversation order. */
  removed: z.array(z.string()),
  /** The grants forgotten, as the context stored them. */
  forgotten: z.array(z.string()),
});

export const contextsRewindOperation = defineOperation<
  typeof contextsRewindInput,
  typeof contextsRewindOutput,
  BureauContextsRewindOperationHost
>({
  name: 'bureau.contexts.rewind',
  mcpExposable: false,
  summary: 'Take a turn back out of a context',
  description:
    'Removes the row `fromMessageId` and every row after it from one of the caller’s own contexts, so a turn that failed can be sent again over a thread that never held the failed attempt; a thread read again does not bring the rows back. Each tool named in `forgetGrantsFor` also loses its “Allow for the rest of this chat” grant, so a tool that changes things asks again. A row the context does not hold is `NotFound`, a context a run is going on, or a run waits on a tool approval, is a `Conflict` with reason `run-in-progress`, and nothing changes in either. Another owner’s context and a missing one answer `NotFound` for the context. A Bureau that keeps no sessions is `UnsupportedCapability`, and one that is shutting down is `Unavailable` with reason `shutting-down`.',
  destructive: true,
  tags: ['Contexts'],
  inputSchema: contextsRewindInput,
  outputSchema: contextsRewindOutput,
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
        message: 'This Bureau keeps no sessions, so it has no contexts to rewind',
        data: { capability: 'session-store' },
      } satisfies OperationFault;
    }
    const owner = ownerOfPrincipal(principal);
    const session = await host.contexts.get(contextId);
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
    let outcome;
    try {
      outcome = await host.contexts.rewind(contextId, {
        fromMessageId: input.fromMessageId,
        ...(input.forgetGrantsFor === undefined ? {} : { forgetGrantsFor: input.forgetGrantsFor }),
      });
    } catch (error) {
      if (error instanceof BureauError && error.code === 'CONFLICT') {
        throw {
          code: 'Unavailable',
          message: error.message,
          data: { reason: 'shutting-down' },
        } satisfies OperationFault;
      }
      throw error;
    }
    switch (outcome.outcome) {
      case 'rewound':
        return { removed: [...outcome.removed], forgotten: [...outcome.forgotten] };
      case 'not-found':
        throw resourceNotFound('context', contextId);
      case 'message-not-found':
        throw resourceNotFound('message', input.fromMessageId);
      case 'run-in-progress':
        throw {
          code: 'Conflict',
          message:
            'A run is going, or waiting on a tool approval, so the context cannot be rewound',
          data: { reason: 'run-in-progress' },
        } satisfies OperationFault;
    }
  },
});
