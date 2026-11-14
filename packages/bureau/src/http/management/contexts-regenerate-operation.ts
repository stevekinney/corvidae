import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.contexts.regenerate`: replace a context's latest answer with a new one from the model,
 * without running a tool, through `Bureau.contexts.regenerate` (COR-2296). The model is asked once,
 * over the history before the answer, with a toolbox that holds no tool; the new answer keeps the
 * old one's message id, and every other row (the user's message, earlier replies, tool calls, tool
 * results and approvals) is kept as it was. A `commandId` makes the call idempotent: an exact
 * retry, even after a restart, returns the original answer and never asks the model again.
 *
 * Each way a regeneration can be refused is a named fault with a stable `data.reason`, and the
 * history is left as it was:
 *
 * | Refusal                                      | Fault         | `data.reason`                       |
 * | -------------------------------------------- | ------------- | ----------------------------------- |
 * | a missing or invisible context               | `NotFound`    | none (`data.resource` is `context`) |
 * | a message the context does not hold          | `NotFound`    | none (`data.resource` is `message`) |
 * | not the last reply of an ended run           | `Conflict`    | `not-a-branch-point`                |
 * | a tool approval is still pending             | `Conflict`    | `branch-with-pending-approval`      |
 * | a tool call has no result                    | `Conflict`    | `branch-with-unresolved-tool-call`  |
 * | a later row, or a newer or live run          | `Conflict`    | `not-latest-answer`                 |
 * | the context changed after it was read        | `Conflict`    | `history-changed`                   |
 * | the `commandId` named another message        | `Conflict`    | `command-conflict`                  |
 * | an earlier attempt is pending, no receipt    | `Conflict`    | `command-in-doubt`                  |
 * | the answer asked for a tool                  | `Unprocessable` | `answer-has-tool-calls`           |
 * | model failure, policy refusal or guardrail   | `Unavailable` | `generation-failed`                 |
 * | the request was aborted before the commit    | `Unavailable` | `aborted`                           |
 * | Bureau is shutting down                      | `Unavailable` | `shutting-down`                     |
 *
 * Regenerating another owner's context reads its history and rewrites it, so it requires both
 * `bureau.contexts:read` and `bureau.contexts:write`; the call writes no audit entry. It is served
 * over JSON-RPC on HTTP alone, whose request's abort signal it reads.
 *
 * @module contexts-regenerate-operation
 */

import { sessionOwnerOf } from '@lostgradient/operative';
import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import { BureauError, BureauShuttingDownError, ContextArchivedError } from '../../bureau-errors.ts';
import { contextArchivedFault } from './contexts-archive-operation.ts';
import { SessionRegenerateRefusedError } from '../../session-regenerate.ts';
import type { BureauContexts } from '../../bureau-types/contexts.ts';
import type { BureauInternals } from '../../bureau-types/facade.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.contexts.regenerate` reads from the handler's `host`. */
export type BureauContextsRegenerateOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'regenerate'> & {
    readonly internals: Pick<BureauInternals, 'sessionStore'>;
  };
};

const contextsRegenerateInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context whose answer to replace.'),
  commandId: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'The caller’s own identifier for the command; an exact retry of it returns the original answer and never asks the model again.',
    ),
  messageId: z
    .string()
    .min(1)
    .describe(
      'The answer to replace: the last row of the context, which must be the last assistant reply of its newest run, and that run must have ended.',
    ),
});

const contextsRegenerateOutput = z.object({
  /** The context whose answer was replaced. */
  contextId: z.string(),
  /** The replaced answer's message id, which the new answer keeps. */
  messageId: z.string(),
  /** The context's revision once the new answer was committed. */
  revision: z.number().int().nonnegative(),
});

/** The fault a refused regeneration answers with; a missing message is named by its identifier. */
function faultForRefusal(error: SessionRegenerateRefusedError, messageId: string): OperationFault {
  switch (error.reason) {
    case 'message-not-found':
      return resourceNotFound('message', messageId);
    case 'answer-has-tool-calls':
      return { code: 'Unprocessable', message: error.message, data: { reason: error.reason } };
    case 'generation-failed':
    case 'aborted':
      return { code: 'Unavailable', message: error.message, data: { reason: error.reason } };
    default:
      return { code: 'Conflict', message: error.message, data: { reason: error.reason } };
  }
}

export const contextsRegenerateOperation = defineOperation<
  typeof contextsRegenerateInput,
  typeof contextsRegenerateOutput,
  BureauContextsRegenerateOperationHost
>({
  name: 'bureau.contexts.regenerate',
  authorize: authorizeWorkspaceOperation('bureau.contexts.regenerate'),
  mcpExposable: false,
  summary: 'Regenerate a context’s latest answer without running a tool',
  description:
    'Replaces the latest answer of one of the caller’s own contexts with a new one from the model, without running any tool. `messageId` must be the last row of the context and the last assistant reply of its newest run, which has ended, with no tool approval pending and no tool call left without a result. The model is asked once, over the history before that answer, with a toolbox that holds no tool, on the model the context’s steering names now (or the agent’s default) as the model policy judges it now; the new answer keeps the message id, and every other row (the user’s message, earlier replies, tool calls, tool results and approvals) is kept as it was. The model is asked under the hooks a run’s step runs: the Bureau’s identity prompt and guardrails, and the agent’s own. An answer that asks for a tool is `Unprocessable` with reason `answer-has-tool-calls`, and a model that fails, that policy refuses, or whose answer a guardrail halts is `Unavailable` with reason `generation-failed`; neither changes the history. The replacement is one compare-and-swap on the context, fenced on the revision the call read: a new turn, a steering change, a deletion, or a new context under the id since then is a `Conflict` with reason `history-changed`, and nothing is written. An aborted request is `Unavailable` with reason `aborted` unless the new answer was already committed. `commandId` is the caller’s own identifier: only the call that claims it asks the model, and an exact retry, even after a restart, returns the original answer without asking it again. A retry while the first call is still going is answered from that call’s committed receipt, or as a `Conflict` with reason `command-in-doubt`; the same `commandId` for another message is a `Conflict` with reason `command-conflict`. A message the context does not hold is `NotFound`; any other message that cannot be regenerated is a `Conflict` with reason `not-a-branch-point`, `branch-with-pending-approval`, `branch-with-unresolved-tool-call`, or `not-latest-answer`. An archived context (`bureau.contexts.archive`) asks no model: it is a `Conflict` with reason `context-archived`. A Bureau that is shutting down is `Unavailable` with reason `shutting-down`. Another owner’s context and a missing one answer `NotFound`. Regenerating another owner’s context reads and rewrites its history, so it requires both `bureau.contexts:read` and `bureau.contexts:write`; a caller holding only one of them is answered `NotFound`. No scope is needed for the caller’s own. The call writes no audit entry.',
  destructive: true,
  tags: ['Contexts'],
  inputSchema: contextsRegenerateInput,
  outputSchema: contextsRegenerateOutput,
  producibleFaults: [
    'InvalidParams',
    'NotFound',
    'Conflict',
    'Unprocessable',
    'UnsupportedCapability',
    'Unavailable',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal, signal }) => {
    const { contextId } = input;
    if (host.contexts.internals.sessionStore === undefined) {
      throw {
        code: 'UnsupportedCapability',
        message: 'This Bureau keeps no sessions, so it has no answers to regenerate',
        data: { capability: 'session-store' },
      } satisfies OperationFault;
    }
    const owner = ownerOfPrincipal(principal);
    // The one session loaded here is the one authorized and the one rewritten. A regeneration
    // reads another owner's history and rewrites it, so it needs the read scope as well as the
    // write scope: neither implies the other.
    const session = await host.contexts.get(contextId);
    const mayAct = (operatorScope: 'bureau.contexts:read' | 'bureau.contexts:write') =>
      session !== undefined &&
      host.ownership.mayAccess({
        principal,
        resourceOwner: sessionOwnerOf(session.metadata) ?? undefined,
        operatorScope,
      });
    if (
      owner === undefined ||
      session === undefined ||
      !mayAct('bureau.contexts:read') ||
      !mayAct('bureau.contexts:write')
    ) {
      throw resourceNotFound('context', contextId);
    }
    try {
      const result = await host.contexts.regenerate(contextId, {
        owner,
        commandId: input.commandId,
        messageId: input.messageId,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        contextId: result.contextId,
        messageId: result.messageId,
        revision: result.revision,
      };
    } catch (error) {
      if (error instanceof SessionRegenerateRefusedError) {
        throw faultForRefusal(error, input.messageId);
      }
      if (error instanceof ContextArchivedError) throw contextArchivedFault(error.message);
      if (error instanceof BureauShuttingDownError) {
        throw {
          code: 'Unavailable',
          message: error.message,
          data: { reason: 'shutting-down' },
        } satisfies OperationFault;
      }
      if (error instanceof BureauError && error.code === 'NOT_FOUND') {
        throw resourceNotFound('context', contextId);
      }
      throw error;
    }
  },
});
