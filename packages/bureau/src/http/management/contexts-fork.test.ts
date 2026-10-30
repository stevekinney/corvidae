/**
 * COR-1560 — `bureau.contexts.fork` branches a context after a completed agent reply and answers
 * with the new `contextId` and the outcome of carrying the parent's model override. Each way a
 * branch can be refused is a typed fault with a stable `data.reason`, and nothing is created.
 */
import { createAgent } from '@lostgradient/operative';
import { createOperationHandler, unauthenticatedLocalAuthContext } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { BureauError, BureauShuttingDownError } from '../../create-bureau.ts';
import { SessionForkRefusedError, type SessionForkRefusalReason } from '../../session-fork.ts';
import { waitForTaskState } from '../../test';
import { noopTool, OPUS_5, OPUS_5_5 } from '../../testing/model-override.test-support.ts';
import { buildBureauHandlerHost, BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import {
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

const agent = createAgent({
  name: 'agent',
  tools: { noop: noopTool },
  allowedCandidates: [OPUS_5_5, OPUS_5],
  generate: async (context) => {
    const history = context.conversation.current;
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
  const opened = await openBureau({ agents: { agent } });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

async function finishedSession(opened: OpenedBureau, principal: string = OWNER.alice) {
  const run = await opened.bureau.tasks.start('agent', 'go', { principal });
  await waitForTaskState(opened.bureau, run.id);
  return run;
}

const forkCall = (
  opened: OpenedBureau,
  contextId: string,
  key: string,
  params: Record<string, unknown> = {},
): Promise<RpcBody> =>
  rpc(
    opened.handler,
    'bureau.contexts.fork',
    { contextId, commandId: 'fork-1', throughMessageId: contextId, ...params },
    key,
  );

describe('bureau.contexts.fork', () => {
  it('answers the new contextId, and the fork shows its lineage in list and get', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const through = `${run.id}:step:1`;

      const body = await forkCall(opened, run.contextId, 'alice-key', {
        throughMessageId: through,
      });

      expect(body.error).toBeUndefined();
      expect(body.result).toMatchObject({ carriedOverride: null });
      const contextId = body.result?.['contextId'] as string;
      const list = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');
      const rows = list.result?.['contexts'] as Array<Record<string, unknown>>;
      expect(rows.find((row) => row['id'] === contextId)).toMatchObject({
        parentContextId: run.contextId,
        forkedFromMessageId: through,
        owner: OWNER.alice,
      });
      expect(rows.find((row) => row['id'] === run.contextId)).toMatchObject({
        parentContextId: null,
        forkedFromMessageId: null,
      });
      const get = await rpc(opened.handler, 'bureau.contexts.get', { contextId }, 'alice-key');
      expect(get.result).toMatchObject({
        parentContextId: run.contextId,
        forkedFromMessageId: through,
        model: null,
        configVersion: 0,
      });
    });
  });

  it('carries the parent’s model override and returns the outcome beside the contextId', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      await rpc(
        opened.handler,
        'bureau.contexts.steer',
        { contextId: run.contextId, commandId: 'switch', override: OPUS_5 },
        'alice-key',
      );

      const body = await forkCall(opened, run.contextId, 'alice-key', {
        throughMessageId: `${run.id}:step:1`,
      });

      expect(body.result).toMatchObject({
        carriedOverride: { outcome: 'accepted', command: { id: 'fork-1:model' } },
      });
      const get = await rpc(
        opened.handler,
        'bureau.contexts.get',
        { contextId: body.result?.['contextId'] },
        'alice-key',
      );
      expect(get.result).toMatchObject({
        model: { provider: 'anthropic', model: 'claude-opus-5' },
      });
    });
  });

  it('answers an exact retry with the same result, and another message under the command as a Conflict', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const second = await opened.bureau.tasks.start('agent', 'again', {
        contextId: run.contextId,
        principal: OWNER.alice,
      });
      await waitForTaskState(opened.bureau, second.id);
      const first = await forkCall(opened, run.contextId, 'alice-key', {
        throughMessageId: `${run.id}:step:1`,
      });

      const retry = await forkCall(opened, run.contextId, 'alice-key', {
        throughMessageId: `${run.id}:step:1`,
      });
      const other = await forkCall(opened, run.contextId, 'alice-key', {
        throughMessageId: `${second.id}:step:1`,
      });

      expect(retry.result).toEqual(first.result);
      expect(other.error?.data).toMatchObject({
        weftCode: 'Conflict',
        reason: 'command-conflict',
      });
    });
  });

  it('answers a user message as a Conflict not-a-branch-point, and a missing message as NotFound', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const session = await opened.bureau.contexts.get(run.contextId);

      const user = await forkCall(opened, run.contextId, 'alice-key', {
        throughMessageId: session!.conversationHistory.ids[0],
      });
      const missing = await forkCall(opened, run.contextId, 'alice-key', {
        commandId: 'fork-2',
        throughMessageId: 'no-such-message',
      });

      expect(user.error?.data).toMatchObject({
        weftCode: 'Conflict',
        reason: 'not-a-branch-point',
      });
      // The fault names the message by its identifier, as every other `NotFound` names its resource.
      expect(missing.error?.data).toMatchObject({
        weftCode: 'NotFound',
        resource: 'message',
        identifier: 'no-such-message',
      });
    });
  });

  it('forks before the first message with a null throughMessageId, owned by the caller, and takes the edited input', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const before = await opened.bureau.contexts.get(run.contextId);

      const body = await forkCall(opened, run.contextId, 'alice-key', { throughMessageId: null });

      expect(body.error).toBeUndefined();
      const contextId = body.result?.['contextId'] as string;
      const get = await rpc(opened.handler, 'bureau.contexts.get', { contextId }, 'alice-key');
      expect(get.result).toMatchObject({
        parentContextId: run.contextId,
        forkedFromMessageId: null,
        owner: OWNER.alice,
        messageCount: 0,
      });
      // The edited text goes to the fork, as a new turn on it; the original is unchanged.
      const edited = await opened.bureau.tasks.start('agent', 'the edited first message', {
        contextId,
        principal: OWNER.alice,
      });
      await waitForTaskState(opened.bureau, edited.id);
      const fork = await opened.bureau.contexts.get(contextId);
      const first = fork?.conversationHistory.ids[0];
      expect(fork?.conversationHistory.messages[first ?? '']?.content).toBe(
        'the edited first message',
      );
      expect(await opened.bureau.contexts.get(run.contextId)).toEqual(before);
    });
  });

  it('answers a null fork of another owner’s context and of a missing one as the same context not found', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);

      const foreign = await forkCall(opened, run.contextId, 'bob-key', { throughMessageId: null });
      const missing = await forkCall(opened, 'no-such-context', 'alice-key', {
        throughMessageId: null,
      });

      expect(foreign.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
      expect(missing.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
    });
  });

  it('still rejects an empty throughMessageId', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);

      const body = await forkCall(opened, run.contextId, 'alice-key', { throughMessageId: '' });

      expect(body.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
    });
  });

  it('answers another owner’s context and a missing one as the same not found, and lets an operator holding read and write branch any', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const through = `${run.id}:step:1`;

      const foreign = await forkCall(opened, run.contextId, 'bob-key', {
        throughMessageId: through,
      });
      const missing = await forkCall(opened, 'no-such-context', 'alice-key');
      const operator = await forkCall(opened, run.contextId, 'operator-key', {
        commandId: 'operator-fork',
        throughMessageId: through,
      });

      expect(foreign.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
      expect(missing.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
      expect(operator.error).toBeUndefined();
      const child = await opened.bureau.contexts.get(operator.result?.['contextId'] as string);
      expect(child?.metadata['sessionOwner']).toBe('api-key:operator');
    });
  });

  it('refuses a caller holding only the write scope, since a fork would copy a history it may not read', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const before = await opened.bureau.contexts.list();

      const writeOnly = await forkCall(opened, run.contextId, 'contexts-writer-key', {
        commandId: 'write-only-fork',
        throughMessageId: `${run.id}:step:1`,
      });

      // The same answer as a context the caller may not see, and nothing is created.
      expect(writeOnly.error?.data).toMatchObject({
        weftCode: 'NotFound',
        resource: 'context',
        identifier: run.contextId,
      });
      const after = await opened.bureau.contexts.list();
      expect(after.length).toBe(before.length);
    });
  });

  it('refuses a request without a command or a message, or with a key it does not declare', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);

      for (const params of [
        { commandId: '' },
        { throughMessageId: '' },
        { throughMessageId: undefined },
        { owner: 'someone-else' },
      ]) {
        const body = await forkCall(opened, run.contextId, 'alice-key', params);
        expect(body.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
      }
    });
  });
});

describe('bureau.contexts.fork refusals', () => {
  /** The operations served over `bureau`, with the fork verb replaced by `fork`. */
  function stubbed(opened: OpenedBureau, fork: () => Promise<unknown>) {
    const host = buildBureauHandlerHost(opened.bureau, []);
    return createOperationHandler({
      operations: BUREAU_HANDLER_OPERATIONS,
      host: {
        ...host,
        contexts: {
          get: opened.bureau.contexts.get,
          internals: { sessionStore: opened.bureau.internals.sessionStore },
          fork,
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
          method: 'bureau.contexts.fork',
          params: { contextId, commandId: 'c', throughMessageId: 'm' },
        }),
      }),
    );
    return (await response.json()) as RpcBody;
  };

  it.each([
    'not-a-branch-point',
    'branch-with-pending-approval',
    'branch-with-unresolved-tool-call',
    'command-conflict',
  ] satisfies SessionForkRefusalReason[])(
    'answers %s as a Conflict with that reason',
    async (reason) => {
      await withBureau(async (opened) => {
        const run = await finishedSession(opened, 'anonymous:local');
        const handler = stubbed(opened, async () => {
          throw new SessionForkRefusedError(reason, 'refused');
        });

        const body = await call(handler, run.contextId);

        expect(body.error?.data).toMatchObject({ weftCode: 'Conflict', reason });
      });
    },
  );

  it('answers a shutting-down Bureau as Unavailable', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'anonymous:local');
      const handler = stubbed(opened, async () => {
        throw new BureauShuttingDownError(
          'Cannot fork: Bureau is shutting down.',
          '2026-10-22T00:00:00.000Z',
        );
      });

      const body = await call(handler, run.contextId);

      expect(body.error?.data).toMatchObject({ weftCode: 'Unavailable', reason: 'shutting-down' });
    });
  });

  it('does not report another conflict, such as steering contention, as shutting down', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'anonymous:local');
      const handler = stubbed(opened, async () => {
        throw new BureauError('Steering for this session is contended.', 'CONFLICT');
      });

      const body = await call(handler, run.contextId);

      expect(body.error).toBeDefined();
      expect(body.error?.data).not.toMatchObject({ reason: 'shutting-down' });
      expect(body.error?.data).not.toMatchObject({ weftCode: 'Unavailable' });
    });
  });
});
