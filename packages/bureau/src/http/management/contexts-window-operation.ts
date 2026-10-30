/**
 * `bureau.contexts.window`: how full a context's window is, through `Bureau.contexts.window`
 * (COR-1937).
 *
 * The report is the estimated size of the prompt the context's next step would send, split by what
 * fills it, beside the provider's own count for the latest step and the window of the model that
 * would answer. Authorization is `bureau.contexts.get`'s: the owner, or a caller holding
 * `bureau.contexts:read`, and anyone else is answered as for a missing context. The report holds
 * counts only, no message text.
 *
 * @module contexts-window-operation
 */

import { defineOperation } from '@lostgradient/weft';
import { z } from 'zod';

import type { BureauContexts, BureauInternals } from '../../types.ts';
import { type BureauOwnershipHost } from '../owner-predicate.ts';
import { mayAccessLoadedContext, noSessions } from './contexts-operations.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.contexts.window` reads from the handler's `host`. */
export type BureauContextsWindowOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'window'> & {
    readonly internals: Pick<BureauInternals, 'sessionStore'>;
  };
};

const contextsWindowInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context to measure.'),
});

const nonNegativeInteger = z.number().int().nonnegative();

/** What `bureau.contexts.window` answers with. */
export const contextWindowSchema = z.object({
  maxTokens: nonNegativeInteger
    .nullable()
    .describe('The model’s context window in tokens, or `null` when the model is not known.'),
  usedEstimated: nonNegativeInteger.describe(
    'The estimated tokens of the next prompt; always the sum of `categories`.',
  ),
  usedReported: nonNegativeInteger
    .nullable()
    .describe('The input tokens the provider reported for the latest step, or `null`.'),
  categories: z
    .array(
      z.object({
        name: z.enum(['system', 'tools', 'messages', 'memory', 'attachments']),
        tokens: nonNegativeInteger,
      }),
    )
    .describe('The estimate split by what fills the window.'),
});

export const contextsWindowOperation = defineOperation<
  typeof contextsWindowInput,
  typeof contextWindowSchema,
  BureauContextsWindowOperationHost
>({
  name: 'bureau.contexts.window',
  mcpExposable: false,
  summary: 'Read how full a context’s window is',
  description:
    'Returns how full one of the caller’s own contexts’ windows is; a caller holding `bureau.contexts:read` reads any owner’s. `usedEstimated` is an estimate (four characters to a token; an attachment by its byte size) of the prompt the context’s next step would send, and always equals the sum of `categories`, which lists `system` (the instructions), `tools` (the schemas offered), `messages` (the conversation after any compaction), `memory` (recalled memory) and `attachments` (media) once each, in that order. `usedReported` is the provider’s own count, never an estimate: the input tokens (fresh, cache-read and cache-written) of the context’s latest step, or `null` when there is none or the provider reported none; it describes the request that step sent, so it lags the estimate by that step’s reply and tool results. `maxTokens` is the context window of the model that would answer, from the model catalog: the context’s steered model (`bureau.contexts.steer`), else its agent’s default, and `null` when neither names a catalog row. It works for an idle context, a context with no run (estimated from its agent’s definition), and a running one, which it reads without waiting on the run. A run saves its rows only when it ends, so a context mid-run still holds the rows it started with (its instructions and the input): `usedEstimated` can then lag `usedReported`, which counts the steps already sent (once the run ends, the reverse holds: `usedReported` predates the reply). A managed-asset attachment is sized from its stored byte length. It calls no model and writes nothing. Another owner’s context answers as a missing one does. The response carries counts only, no message text.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: contextsWindowInput,
  outputSchema: contextWindowSchema,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { contextId } = input;
    if (host.contexts.internals.sessionStore === undefined) throw noSessions();
    // The one session loaded here is the one authorized and the one measured.
    const session = await host.contexts.get(contextId);
    if (
      session === undefined ||
      !mayAccessLoadedContext(host, principal, session, 'bureau.contexts:read')
    ) {
      throw resourceNotFound('context', contextId);
    }
    const report = await host.contexts.window(contextId, { incarnation: session.incarnation });
    // The id holds another incarnation now (or none): the context authorized is gone.
    if (report === undefined) throw resourceNotFound('context', contextId);
    return {
      maxTokens: report.maxTokens,
      usedEstimated: report.usedEstimated,
      usedReported: report.usedReported,
      categories: report.categories.map((category) => ({ ...category })),
    };
  },
});
