/**
 * COR-1560 — `bureau.contexts.fork` branches a context after a completed agent reply and answers
 * with the new `contextId` and the outcome of carrying the parent's model override. Each way a
 * branch can be refused is a typed fault with a stable `data.reason`, and nothing is created.
 */
import { createAgent } from '@lostgradient/operative';
import { createOperationHandler, unauthenticatedLocalAuthContext } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { BureauError } from '../../create-bureau.ts';
import { SessionForkRefusedError, type SessionForkRefusalReason } from '../../session-fork.ts';
import { waitForRunState } from '../../test';
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
      return { content: 'thinking', toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }] };
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
  const run = await opened.bureau.createRun({ message: 'go', agentName: 'agent', principal });
  await waitForRunState(opened.bureau, run.id);
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
    { contextId, commandId: 'fork-1', throughMessageId: `${contextId}`, ...params },
    key,
  );

describe('bureau.contexts.fork', () => {
  it('answers the new contextId, and the fork shows its lineage in list and get', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const through = `${run.id}:step:1`;

      const body = await forkCall(opened, run.sessionId, 'alice-key', { throughMessageId: through });

      expect(body.error).toBeUndefined();
      expect(body.result).toMatchObject({ carriedOverride: null });
      const contextId = body.result?.['contextId'] as string;
      const list = await rpc(opened.handler, 'bureau.contexts.list', {}, 'alice-key');
      const rows = list.result?.['contexts'] as Array<Record<string, unknown>>;
      expect(rows.find((row) => row['id'] === contextId)).toMatchObject({
        parentContextId: run.sessionId,
        forkedFromMessageId: through,
        owner: OWNER.alice,
      });
      expect(rows.find((row) => row['id'] === run.sessionId)).toMatchObject({
        parentContextId: null,
        forkedFromMessageId: null,
      });
      const get = await rpc(opened.handler, 'bureau.contexts.get', { contextId }, 'alice-key');
      expect(get.result).toMatchObject({
        parentContextId: run.sessionId,
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
        { contextId: run.sessionId, commandId: 'switch', override: OPUS_5 },
        'alice-key',
      );

      const body = await forkCall(opened, run.sessionId, 'alice-key', {
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
      expect(get.result).toMatchObject({ model: { provider: 'anthropic', model: 'claude-opus-5' } });
    });
  });

  it('answers an exact retry with the same result, and another message under the command as a Conflict', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const second = await opened.bureau.createRun({
        message: 'again',
        agentName: 'agent',
        principal: OWNER.alice,
        sessionId: run.sessionId,
      });
      await waitForRunState(opened.bureau, second.id);
      const first = await forkCall(opened, run.sessionId, 'alice-key', {
        throughMessageId: `${run.id}:step:1`,
      });

      const retry = await forkCall(opened, run.sessionId, 'alice-key', {
        throughMessageId: `${run.id}:step:1`,
      });
      const other = await forkCall(opened, run.sessionId, 'alice-key', {
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
      const session = await opened.bureau.getSession(run.sessionId);

      const user = await forkCall(opened, run.sessionId, 'alice-key', {
        throughMessageId: session!.conversationHistory.ids[0],
      });
      const missing = await forkCall(opened, run.sessionId, 'alice-key', {
        commandId: 'fork-2',
        throughMessageId: 'no-such-message',
      });

      expect(user.error?.data).toMatchObject({ weftCode: 'Conflict', reason: 'not-a-branch-point' });
      expect(missing.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'message' });
    });
  });

  it('answers another owner’s context and a missing one as the same not found, and lets an operator branch any', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const through = `${run.id}:step:1`;

      const foreign = await forkCall(opened, run.sessionId, 'bob-key', { throughMessageId: through });
      const missing = await forkCall(opened, 'no-such-context', 'alice-key');
      const operator = await forkCall(opened, run.sessionId, 'contexts-writer-key', {
        commandId: 'operator-fork',
        throughMessageId: through,
      });

      expect(foreign.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
      expect(missing.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
      expect(operator.error).toBeUndefined();
      const child = await opened.bureau.getSession(operator.result?.['contextId'] as string);
      expect(child?.metadata['sessionOwner']).toBe('api-key:contexts-writer');
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
        const body = await forkCall(opened, run.sessionId, 'alice-key', params);
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
          getSession: opened.bureau.getSession,
          sessionStore: opened.bureau.sessionStore,
          forkSession: fork,
        } as never,
      },
      authenticate: async () => ({
        method: 'unauthenticated-local' as const,
        principal: unauthenticatedLocalAuthContext().principal!,
      }),
      publicPaths: [],
    });
  }

  const call = async (handler: (request: Request) => Promise<Response>, contextId: string) =>
    (await (
      await handler(
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
      )
    ).json()) as RpcBody;

  it.each([
    'not-a-branch-point',
    'branch-from-errored-run',
    'branch-from-aborted-run',
    'branch-with-pending-approval',
    'branch-with-unresolved-tool-call',
    'command-conflict',
  ] satisfies SessionForkRefusalReason[])('answers %s as a Conflict with that reason', async (reason) => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'anonymous:local');
      const handler = stubbed(opened, async () => {
        throw new SessionForkRefusedError(reason, 'refused');
      });

      const body = await call(handler, run.sessionId);

      expect(body.error?.data).toMatchObject({ weftCode: 'Conflict', reason });
    });
  });

  it('answers a shutting-down Bureau as Unavailable', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened, 'anonymous:local');
      const handler = stubbed(opened, async () => {
        throw new BureauError('Cannot fork: Bureau is shutting down.', 'CONFLICT');
      });

      const body = await call(handler, run.sessionId);

      expect(body.error?.data).toMatchObject({ weftCode: 'Unavailable', reason: 'shutting-down' });
    });
  });
});
