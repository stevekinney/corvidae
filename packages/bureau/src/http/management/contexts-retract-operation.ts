/**
 * `bureau.contexts.retract`: take back one input the caller sent to a context with
 * `bureau.contexts.input`, before the context's run takes it. This is the Remove on a queued
 * follow-up (B06, row 18k): a message sent while the run is working is held until the run's next
 * step boundary, and retracting it cancels it there, so it is never delivered.
 *
 * The principal is the caller and never a payload field; only the principal that sent an input
 * can retract it. A caller reaches its own contexts without a scope and `bureau.contexts:write` is
 * the operator scope, as for `bureau.contexts.input`; a context the caller may not see is answered
 * exactly as a missing one, and an unknown input id and another principal's input exactly as a
 * missing input (`data.resource` `input`).
 *
 * | Outcome                  | Answer                                                     |
 * | ------------------------ | ---------------------------------------------------------- |
 * | `retracted`              | `{ outcome: 'retracted', receipt }`, the receipt `canceled` |
 * | `delivered`              | `{ outcome: 'delivered', receipt }`: too late, it stands    |
 * | `not-found`              | `NotFound` (`data.resource`)                               |
 * | `unsupported-capability` | `Unavailable` with reason `unsupported-capability`         |
 *
 * A Bureau that is shutting down is `Unavailable` with reason `shutting-down`.
 *
 * @module contexts-retract-operation
 */

import { sessionOwnerOf, type SessionInputRetractionOutcome } from '@lostgradient/operative';
import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';
import { BureauError } from '../../bureau-errors.ts';
import type { BureauContexts } from '../../bureau-types/contexts.ts';
import type { BureauInternals } from '../../bureau-types/facade.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';
import { inputReceiptSchema } from './contexts-input-operation.ts';

/** What `bureau.contexts.retract` reads from the handler's `host`. */
export type BureauContextsRetractOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'retract'> & {
    readonly internals: Pick<BureauInternals, 'sessionStore'>;
  };
};

const contextsRetractInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context the input was sent to.'),
  inputId: z
    .string()
    .min(1)
    .max(256)
    .describe('The `id` the input was sent under with `bureau.contexts.input`.'),
});

const contextsRetractOutput = z.object({
  /**
   * `retracted` when the input will never be delivered, `delivered` when the run had already taken
   * it into the conversation and it stands.
   */
  outcome: z.enum(['retracted', 'delivered']),
  receipt: inputReceiptSchema,
});

export const contextsRetractOperation = defineOperation<
  typeof contextsRetractInput,
  typeof contextsRetractOutput,
  BureauContextsRetractOperationHost
>({
  name: 'bureau.contexts.retract',
  authorize: authorizeWorkspaceOperation('bureau.contexts.retract'),
  mcpExposable: false,
  summary: 'Take back input sent to a context',
  description:
    'Takes back the input the caller sent to one of its own contexts under `inputId` with `bureau.contexts.input`, before the context’s run takes it, so it is never delivered. The `outcome` is `retracted` when the input was cancelled in time, or had already ended undelivered (its `receipt` reads `canceled`, `expired` or `failed`), and `delivered` when the run had already taken it into the conversation or holds it at the step that is appending it: the turn stands, and the `receipt` reads `promoted`, or `accepted` until that step commits. Another owner’s context and a missing one answer `NotFound` for the context, and an unknown `inputId` and an input another principal sent answer `NotFound` for the input. A Bureau that keeps no session mailbox is `Unavailable` with reason `unsupported-capability`, and one that is shutting down is `Unavailable` with reason `shutting-down`.',
  destructive: true,
  tags: ['Contexts'],
  inputSchema: contextsRetractInput,
  outputSchema: contextsRetractOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability', 'Unavailable'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { contextId, inputId } = input;
    if (host.contexts.internals.sessionStore === undefined) {
      throw {
        code: 'UnsupportedCapability',
        message: 'This Bureau keeps no sessions, so it has no contexts to take input back from',
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
    let outcome: SessionInputRetractionOutcome;
    try {
      outcome = await host.contexts.retract(contextId, { id: inputId, principal: owner });
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
      case 'retracted':
      case 'delivered':
        return { outcome: outcome.outcome, receipt: { ...outcome.receipt } };
      case 'not-found':
        throw resourceNotFound('input', inputId);
      case 'unsupported-capability':
        throw {
          code: 'Unavailable',
          message: 'This Bureau cannot take input back from a context',
          data: { reason: 'unsupported-capability' },
        } satisfies OperationFault;
    }
  },
});
