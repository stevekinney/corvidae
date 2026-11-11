/**
 * COR-2296 — `bureau.contexts.regenerate` replaces a context's latest answer with a new one from
 * the model, without running a tool, and answers the context, the message and the committed
 * revision. Its command identity is the caller's owner, the context and the `commandId`; another
 * owner's context needs both context scopes; each refusal is a typed fault with a stable
 * `data.reason`, and the history is left as it was.
 */
import { createAgent } from '@lostgradient/operative';
import { createOperationHandler, unauthenticatedLocalAuthContext } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { BureauShuttingDownError } from '../../bureau-errors.ts';
import {
  SessionRegenerateRefusedError,
  type SessionRegenerateRefusalReason,
} from '../../session-regenerate.ts';
import { waitForCondition, waitForTaskState } from '../../test';
import { noopTool, OPUS_5, OPUS_5_5 } from '../../testing/model-override.test-support.ts';
import { buildBureauHandlerHost, BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import {
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

/** How many regenerations asked the model: calls whose toolbox holds no tool. */
const asked = { regenerations: 0 };

const agent = createAgent({
  name: 'agent',
  tools: { noop: noopTool },
  allowedCandidates: [OPUS_5_5, OPUS_5],
  generate: async (context) => {
    const history = context.conversation.current;
    if (context.toolbox.tools().length === 0) {
      asked.regenerations += 1;
      return { content: 'the regenerated answer', toolCalls: [] };
    }
    const last = history.messages[history.ids.at(-1) ?? ''];
    if (last?.toolResult === undefined) {
      return {
        content: 'thinking',
        toolCalls: [{ id: `c-${history.ids.length}`, name: 'noop', arguments: {} }],
      };
    }
    return { content: 'the answer', toolCalls: [] };
  },
});

async function withBureau<T>(body: (opened: OpenedBureau) => Promise<T>): Promise<T> {
  asked.regenerations = 0;
  const opened = await openBureau({ agents: { agent } });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

/** A finished turn of `principal`'s, once its answer is stored and its record has settled. */
async function finishedSession(opened: OpenedBureau, principal: string = OWNER.alice) {
  const run = await opened.bureau.tasks.start('agent', 'go', { principal });
  await waitForTaskState(opened.bureau, run.id);
  const answer = `${run.id}:step:1`;
  await waitForCondition(async () => {
    const record = await opened.bureau.internals.taskRegistry.record(run.id);
    const stored = await opened.bureau.contexts.get(run.contextId);
    return record?.settled !== undefined && stored?.conversationHistory.ids.at(-1) === answer;
  }, 'the answer is stored');
  return { ...run, answer };
}

const regenerateCall = (
  opened: OpenedBureau,
  contextId: string,
  key: string,
  params: Record<string, unknown> = {},
): Promise<RpcBody> =>
  rpc(
    opened.handler,
    'bureau.contexts.regenerate',
    { contextId, commandId: 'regenerate-1', messageId: 'unset', ...params },
    key,
  );

describe('bureau.contexts.regenerate', () => {
  it('replaces the latest answer and answers the context, the message and the revision', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const before = await opened.bureau.contexts.get(run.contextId);

      const body = await regenerateCall(opened, run.contextId, 'alice-key', {
        messageId: run.answer,
      });

      expect(body.error).toBeUndefined();
      const after = await opened.bureau.contexts.get(run.contextId);
      expect(body.result).toEqual({
        contextId: run.contextId,
        messageId: run.answer,
        revision: after?.revision,
      });
      expect(after?.conversationHistory.ids).toEqual(before?.conversationHistory.ids);
      expect(after?.conversationHistory.messages[run.answer]?.content).toBe(
        'the regenerated answer',
      );
      expect(asked.regenerations).toBe(1);
    });
  });

  it('answers an exact retry with the same result and no model call, and another message under the command as a Conflict', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const first = await regenerateCall(opened, run.contextId, 'alice-key', {
        messageId: run.answer,
      });

      const retry = await regenerateCall(opened, run.contextId, 'alice-key', {
        messageId: run.answer,
      });
      const other = await regenerateCall(opened, run.contextId, 'alice-key', {
        messageId: `${run.id}:step:0`,
      });

      expect(retry.result).toEqual(first.result);
      expect(other.error?.data).toMatchObject({ weftCode: 'Conflict', reason: 'command-conflict' });
      expect(asked.regenerations).toBe(1);
    });
  });

  it('answers a user message as a Conflict not-a-branch-point, and a missing message as NotFound', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const session = await opened.bureau.contexts.get(run.contextId);

      const user = await regenerateCall(opened, run.contextId, 'alice-key', {
        messageId: session!.conversationHistory.ids[0],
      });
      const missing = await regenerateCall(opened, run.contextId, 'alice-key', {
        commandId: 'regenerate-2',
        messageId: 'no-such-message',
      });

      expect(user.error?.data).toMatchObject({
        weftCode: 'Conflict',
        reason: 'not-a-branch-point',
      });
      expect(missing.error?.data).toMatchObject({
        weftCode: 'NotFound',
        resource: 'message',
        identifier: 'no-such-message',
      });
      expect(asked.regenerations).toBe(0);
      expect(await opened.bureau.contexts.get(run.contextId)).toEqual(session);
    });
  });

  it('answers another owner’s context and a missing one as the same not found, and lets an operator holding read and write regenerate any', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const before = await opened.bureau.contexts.get(run.contextId);

      const foreign = await regenerateCall(opened, run.contextId, 'bob-key', {
        messageId: run.answer,
      });
      const missing = await regenerateCall(opened, 'no-such-context', 'alice-key', {
        messageId: run.answer,
      });

      expect(foreign.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
      expect(missing.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
      expect(await opened.bureau.contexts.get(run.contextId)).toEqual(before);
      expect(asked.regenerations).toBe(0);

      const operator = await regenerateCall(opened, run.contextId, 'operator-key', {
        commandId: 'operator-regenerate',
        messageId: run.answer,
      });

      expect(operator.error).toBeUndefined();
      expect(asked.regenerations).toBe(1);
    });
  });

  it('refuses a caller holding only the write scope, since a regeneration reads the history', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const before = await opened.bureau.contexts.get(run.contextId);

      const writeOnly = await regenerateCall(opened, run.contextId, 'contexts-writer-key', {
        commandId: 'write-only-regenerate',
        messageId: run.answer,
      });

      expect(writeOnly.error?.data).toMatchObject({
        weftCode: 'NotFound',
        resource: 'context',
        identifier: run.contextId,
      });
      expect(await opened.bureau.contexts.get(run.contextId)).toEqual(before);
      expect(asked.regenerations).toBe(0);
    });
  });

  it('refuses a request without a command or a message, or with a key it does not declare', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);

      for (const params of [
        { commandId: '', messageId: run.answer },
        { messageId: '' },
        { messageId: undefined },
        { messageId: run.answer, owner: 'someone-else' },
      ]) {
        const body = await regenerateCall(opened, run.contextId, 'alice-key', params);
        expect(body.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
      }
      expect(asked.regenerations).toBe(0);
    });
  });
});

describe('bureau.contexts.regenerate refusals', () => {
  /** The operations served over `bureau`, with the regenerate verb replaced by `regenerate`. */
  function stubbed(opened: OpenedBureau, regenerate: () => Promise<unknown>) {
    const host = buildBureauHandlerHost(opened.bureau, []);
    return createOperationHandler({
      operations: BUREAU_HANDLER_OPERATIONS,
      host: {
        ...host,
        contexts: {
          get: opened.bureau.contexts.get,
          internals: { sessionStore: opened.bureau.internals.sessionStore },
          regenerate,
        } as never,
      },
      authenticate: async () => ({
        method: 'unauthenticated-local' as const,
        principal: unauthenticatedLocalAuthContext().principal!,
      }),
      publicPaths: [],
    });
  }

  const call = async (handler: (request: Request) => Promise<Response>, contextId: string) => {
    const response = await handler(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'bureau.contexts.regenerate',
          params: { contextId, commandId: 'c', messageId: 'm' },
        }),
      }),
    );
    return (await response.json()) as RpcBody;
  };

  it.each([
    ['not-a-branch-point', 'Conflict'],
    ['branch-with-pending-approval', 'Conflict'],
    ['branch-with-unresolved-tool-call', 'Conflict'],
    ['not-latest-answer', 'Conflict'],
    ['history-changed', 'Conflict'],
    ['command-conflict', 'Conflict'],
    ['command-in-doubt', 'Conflict'],
    ['answer-has-tool-calls', 'Unprocessable'],
    ['generation-failed', 'Unavailable'],
    ['aborted', 'Unavailable'],
  ] satisfies Array<[SessionRegenerateRefusalReason, string]>)(
    'answers %s as %s with that reason',
    async (reason, weftCode) => {
      await withBureau(async (opened) => {
        const run = await finishedSession(opened, 'anonymous:local');
        const handler = stubbed(opened, async () => {
          throw new SessionRegenerateRefusedError(reason, 'refused');
        });

        const body = await call(handler, run.contextId);

        expect(body.error?.data).toMatchObject({ weftCode, reason });
      });
    },
  );

  it('answers a message the context does not hold as NotFound naming it', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'anonymous:local');
      const handler = stubbed(opened, async () => {
        throw new SessionRegenerateRefusedError('message-not-found', 'refused');
      });

      const body = await call(handler, run.contextId);

      expect(body.error?.data).toMatchObject({
        weftCode: 'NotFound',
        resource: 'message',
        identifier: 'm',
      });
    });
  });

  it('answers a shutting-down Bureau as Unavailable', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'anonymous:local');
      const handler = stubbed(opened, async () => {
        throw new BureauShuttingDownError(
          'Cannot regenerate: Bureau is shutting down.',
          '2026-11-11T00:00:00.000Z',
        );
      });

      const body = await call(handler, run.contextId);

      expect(body.error?.data).toMatchObject({ weftCode: 'Unavailable', reason: 'shutting-down' });
    });
  });

  it('passes the request’s abort signal to the regeneration', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'anonymous:local');
      let seen: AbortSignal | undefined;
      const handler = stubbed(opened, async (...args: unknown[]) => {
        const request = args[1] as { signal?: AbortSignal };
        seen = request.signal;
        return { contextId: run.contextId, messageId: 'm', revision: 3 };
      });

      const body = await call(handler, run.contextId);

      expect(body.result).toEqual({ contextId: run.contextId, messageId: 'm', revision: 3 });
      expect(seen).toBeInstanceOf(AbortSignal);
    });
  });
});
