/**
 * `bureau.contexts.input`: admit one input to a context (a Bureau session) through
 * `Bureau.contexts.input`, so a client can follow up on a run that is still going.
 *
 * The delivery mode is always `steer`: the input reaches the run at its next step boundary
 * (COR-1476), and a run that ends before delivering it cancels it, so the client resends it.
 * The principal is the caller and never a payload field. A caller reaches its own contexts without
 * a scope and `bureau.contexts:write` is the operator scope, as for `bureau.contexts.delete`; a
 * context the caller may not see is answered exactly as a missing one. Bureau admits input only
 * under the session's own authority, so an operator that is not the owner is answered as for a
 * missing context too.
 *
 * Each outcome other than an admission is a named fault with a stable `data.reason`:
 *
 * | Outcome                  | Fault         | `data.reason`            |
 * | ------------------------ | ------------- | ------------------------ |
 * | `not-found`              | `NotFound`    | none (`data.resource`)   |
 * | `conflict`               | `Conflict`    | `input-conflict`         |
 * | `session-terminal`       | `Conflict`    | `session-terminal`       |
 * | `unsupported-capability` | `Unavailable` | `unsupported-capability` |
 * | `backlog-exhausted`      | `Unavailable` | `backlog-exhausted`      |
 *
 * `UnsupportedCapability` and `RateLimited` carry no `reason` on the JSON-RPC wire, and `Unavailable`
 * and `Conflict` do, so a client branches on `data.reason` for every outcome that is not a
 * not-found. A payload no run could read is `InvalidParams` on `input.payload`, and a Bureau that is
 * shutting down is `Unavailable` with reason `shutting-down`.
 *
 * @module contexts-input-operation
 */

import { type SessionInputAdmissionOutcome, sessionOwnerOf } from '@lostgradient/operative';
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

/** What `bureau.contexts.input` reads from the handler's `host`. */
export type BureauContextsInputOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'input'> & {
    readonly internals: Pick<BureauInternals, 'sessionStore'>;
  };
};

/**
 * The payload of an input: text, or an ordered list of parts. Its shape is decided by
 * `Bureau.contexts.input`, which refuses a payload no run could read.
 */
const inputPayloadSchema = z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]);

const contextsInputInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context to send the input to.'),
  input: z
    .object({
      id: z
        .string()
        .min(1)
        .max(256)
        .describe('The caller’s own identifier for the input; an exact retry of it is a replay.'),
      payload: inputPayloadSchema.describe('The input itself: text, or an ordered list of parts.'),
    })
    .strict()
    .describe('The input to admit: an `id` of the caller’s choosing and its `payload`.'),
});

const inputReceiptSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  deliveryMode: z.enum(['steer', 'queue']),
  admissionSequence: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  state: z.enum([
    'accepted',
    'queued',
    'promoted',
    'rejected',
    'expired',
    'superseded',
    'canceled',
    'failed',
  ]),
  admittedAt: z.string(),
});

const contextsInputOutput = z.object({
  /** `replayed` is an exact retry of an input already admitted; its receipt is the current one. */
  outcome: z.enum(['admitted', 'replayed']),
  receipt: inputReceiptSchema,
});

/** The fault an outcome that did not admit the input answers with. */
export function faultForInputOutcome(
  outcome: Exclude<SessionInputAdmissionOutcome, { outcome: 'admitted' | 'replayed' }>,
  contextId: string,
): OperationFault {
  switch (outcome.outcome) {
    case 'not-found':
      return resourceNotFound('context', contextId);
    case 'conflict':
      return {
        code: 'Conflict',
        message: 'This input id was already used for a different input',
        // The original receipt is not shown: for another principal's input it would be theirs.
        data: { reason: 'input-conflict' },
      };
    case 'session-terminal':
      return {
        code: 'Conflict',
        message: 'This context has ended and takes no more input',
        data: { reason: 'session-terminal' },
      };
    case 'unsupported-capability':
      return {
        code: 'Unavailable',
        message: 'This Bureau cannot take input for a context',
        data: { reason: 'unsupported-capability' },
      };
    case 'backlog-exhausted':
      return {
        code: 'Unavailable',
        message: `This context has ${outcome.limit} inputs waiting for its ${outcome.scope === 'principal' ? 'caller' : 'run'}; send more once some are delivered`,
        data: { reason: 'backlog-exhausted' },
      };
  }
}

export const contextsInputOperation = defineOperation<
  typeof contextsInputInput,
  typeof contextsInputOutput,
  BureauContextsInputOperationHost
>({
  name: 'bureau.contexts.input',
  mcpExposable: true,
  summary: 'Send input to a context',
  description:
    'Admits `input` (an `id` of the caller’s choosing and a `payload`: text, or a list of parts) to one of the caller’s own contexts, to be delivered to the context’s run at its next step boundary. The `outcome` is `admitted`, or `replayed` for an exact retry of an `id` already admitted; the `receipt` says where the input stands (`accepted` while it waits, `promoted` once the run took it into the conversation, `canceled` if the run ended or the context had no run to take it). An input is answered by the run it was admitted to or not at all: one that a run ends without delivering is cancelled and must be sent again. Another owner’s context, and a missing one, answer `NotFound`. A different input under an `id` already used is a `Conflict` with reason `input-conflict`, a context that has ended is a `Conflict` with reason `session-terminal`, a Bureau that cannot take input is `Unavailable` with reason `unsupported-capability`, and a context with too much input waiting is `Unavailable` with reason `backlog-exhausted`.',
  destructive: true,
  tags: ['Contexts'],
  inputSchema: contextsInputInput,
  outputSchema: contextsInputOutput,
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
        message: 'This Bureau keeps no sessions, so it has no contexts to send input to',
        data: { capability: 'session-store' },
      } satisfies OperationFault;
    }
    const owner = ownerOfPrincipal(principal);
    // The one session loaded here is the one authorized and the one the input is admitted to.
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
    let outcome: SessionInputAdmissionOutcome;
    try {
      outcome = await host.contexts.input(contextId, {
        id: input.input.id,
        principal: owner,
        deliveryMode: 'steer',
        payload: input.input.payload as never,
      });
    } catch (error) {
      if (error instanceof BureauError && error.code === 'BAD_REQUEST') {
        throw {
          code: 'InvalidParams',
          message: error.message,
          data: {
            issues: [{ path: ['input', 'payload'], message: error.message, code: 'custom' }],
          },
        } satisfies OperationFault;
      }
      if (error instanceof BureauError && error.code === 'CONFLICT') {
        throw {
          code: 'Unavailable',
          message: error.message,
          data: { reason: 'shutting-down' },
        } satisfies OperationFault;
      }
      throw error;
    }
    if (outcome.outcome === 'admitted' || outcome.outcome === 'replayed') {
      return { outcome: outcome.outcome, receipt: { ...outcome.receipt } };
    }
    throw faultForInputOutcome(outcome, contextId);
  },
});
