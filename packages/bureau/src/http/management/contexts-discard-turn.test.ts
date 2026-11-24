/**
 * COR-2437 — `bureau.contexts.discardturn` removes a context's last unfinished turn and answers the
 * context, the run, how many rows went and the committed revision. Another owner's context answers
 * exactly as a missing one, before anything about the run is read; each refusal is a typed fault
 * with a stable `data.reason`, and the history is left as it was.
 */
import { createAgent, type GenerateContext } from '@lostgradient/operative';
import { createOperationHandler, unauthenticatedLocalAuthContext } from '@lostgradient/backchannel';
import { describe, expect, it } from 'bun:test';

import { BureauShuttingDownError } from '../../bureau-errors.ts';
import {
  SessionDiscardRefusedError,
  type SessionDiscardRefusalReason,
} from '../../session-discard.ts';
import { waitForCondition, waitForTaskState } from '../../test';
import { noopTool } from '../../testing/model-override.test-support.ts';
import { buildBureauHandlerHost, BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { bureauFaultPolicy } from '../bureau-fault-policy.ts';
import {
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

/** Settles once a run of the agent below reaches its second step, which waits to be stopped. */
let secondStep = Promise.withResolvers<void>();

/** Thinks and calls a tool, then waits until the run is stopped. */
const agent = createAgent({
  name: 'agent',
  tools: { noop: noopTool },
  generate: async (context: GenerateContext) => {
    const history = context.conversation.current;
    const last = history.messages[history.ids.at(-1) ?? ''];
    if (last?.toolResult === undefined) {
      return {
        content: 'thinking',
        toolCalls: [{ id: `c-${history.ids.length}`, name: 'noop', arguments: {} }],
      };
    }
    secondStep.resolve();
    await new Promise<void>((_resolve, reject) => {
      const signal = context.signal;
      if (signal === undefined) throw new Error('A step of a run is given its signal.');
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return { content: 'never', toolCalls: [] };
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

/** A turn of `principal`'s that was stopped once its first step was done. */
async function stoppedTurn(opened: OpenedBureau, principal: string = OWNER.alice) {
  secondStep = Promise.withResolvers<void>();
  const run = await opened.bureau.tasks.start('agent', 'go', { principal });
  await secondStep.promise;
  await opened.bureau.tasks.cancel(run.id);
  await waitForTaskState(opened.bureau, run.id);
  await waitForCondition(async () => {
    const record = await opened.bureau.internals.taskRegistry.record(run.id);
    const session = await opened.bureau.contexts.get(run.contextId);
    // The run's terminal save, which writes its rows, records its end in the chat last.
    return record?.settled !== undefined && session?.metadata['lastRunId'] === run.id;
  }, 'the run has ended');
  return run;
}

const discardCall = (
  opened: OpenedBureau,
  contextId: string,
  key: string,
  params: Record<string, unknown> = {},
): Promise<RpcBody> =>
  rpc(
    opened.handler,
    'bureau.contexts.discardturn',
    { contextId, commandId: 'discard-1', runId: 'unset', ...params },
    key,
  );

describe('bureau.contexts.discardturn', () => {
  it('removes the stopped turn and answers the context, the run, the count and the revision', async () => {
    await withBureau(async (opened) => {
      const run = await stoppedTurn(opened);
      const before = (await opened.bureau.contexts.get(run.contextId))!;

      const body = await discardCall(opened, run.contextId, 'alice-key', { runId: run.id });

      expect(body.error).toBeUndefined();
      const after = (await opened.bureau.contexts.get(run.contextId))!;
      const kept = before.conversationHistory.ids.filter((id) => !id.startsWith(`${run.id}:`));
      expect(after.conversationHistory.ids).toEqual(kept);
      expect(body.result).toEqual({
        contextId: run.contextId,
        runId: run.id,
        removed: before.conversationHistory.ids.length - kept.length,
        revision: after.revision,
      });
      // An exact retry answers the same, and removes nothing more.
      const retry = await discardCall(opened, run.contextId, 'alice-key', { runId: run.id });
      expect(retry.result).toEqual(body.result);
      expect(await opened.bureau.contexts.get(run.contextId)).toEqual(after);
    });
  });

  it('answers another owner’s context and a missing one as the same not found, whatever the run', async () => {
    await withBureau(async (opened) => {
      const run = await stoppedTurn(opened);
      const before = await opened.bureau.contexts.get(run.contextId);

      const real = await discardCall(opened, run.contextId, 'bob-key', { runId: run.id });
      const random = await discardCall(opened, run.contextId, 'bob-key', { runId: 'no-such-run' });
      const missing = await discardCall(opened, 'no-such-context', 'alice-key', { runId: run.id });

      for (const body of [real, random, missing]) {
        expect(body.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
      }
      // The real run and a made-up one answer alike: nothing of the run is read for a non-owner.
      expect(real.error).toEqual(random.error);
      expect(await opened.bureau.contexts.get(run.contextId)).toEqual(before);
    });
  });

  it('refuses a caller holding only the write scope, since a discard reads the history', async () => {
    await withBureau(async (opened) => {
      const run = await stoppedTurn(opened);
      const before = await opened.bureau.contexts.get(run.contextId);

      const writeOnly = await discardCall(opened, run.contextId, 'contexts-writer-key', {
        runId: run.id,
      });

      expect(writeOnly.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
      expect(await opened.bureau.contexts.get(run.contextId)).toEqual(before);
    });
  });

  it('never lets a scoped operator discard another owner’s turn', async () => {
    await withBureau(async (opened) => {
      const run = await stoppedTurn(opened);
      const before = await opened.bureau.contexts.get(run.contextId);

      const operator = await discardCall(opened, run.contextId, 'operator-key', {
        runId: run.id,
      });

      expect(operator.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
      expect(await opened.bureau.contexts.get(run.contextId)).toEqual(before);
    });
  });

  it('answers a run the context does not have as NotFound naming it', async () => {
    await withBureau(async (opened) => {
      const run = await stoppedTurn(opened);

      const body = await discardCall(opened, run.contextId, 'alice-key', { runId: 'no-such-run' });

      expect(body.error?.data).toMatchObject({
        weftCode: 'NotFound',
        resource: 'run',
        identifier: 'no-such-run',
      });
    });
  });

  it('refuses a request without a command or a run, or with a key it does not declare', async () => {
    await withBureau(async (opened) => {
      const run = await stoppedTurn(opened);

      for (const params of [
        { commandId: '', runId: run.id },
        { runId: '' },
        { runId: undefined },
        { runId: run.id, owner: 'someone-else' },
      ]) {
        const body = await discardCall(opened, run.contextId, 'alice-key', params);
        expect(body.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
      }
    });
  });
});

describe('bureau.contexts.discardturn refusals', () => {
  /** The operations served over `bureau`, with the discard verb replaced by `discardTurn`. */
  function stubbed(opened: OpenedBureau, discardTurn: () => Promise<unknown>) {
    const host = buildBureauHandlerHost(opened.bureau, []);
    return createOperationHandler({
      operations: BUREAU_HANDLER_OPERATIONS,
      host: {
        ...host,
        contexts: {
          get: opened.bureau.contexts.get,
          internals: { sessionStore: opened.bureau.internals.sessionStore },
          discardTurn,
        } as never,
      },
      authenticate: async () => ({
        method: 'unauthenticated-local' as const,
        principal: unauthenticatedLocalAuthContext().principal!,
      }),
      publicPaths: [],
      faultPolicy: bureauFaultPolicy,
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
          method: 'bureau.contexts.discardturn',
          params: { contextId, commandId: 'c', runId: 'r' },
        }),
      }),
    );
    return (await response.json()) as RpcBody;
  };

  it.each([
    'not-latest-turn',
    'turn-running',
    'turn-outcome-unknown',
    'turn-finished',
    'follow-up-delivered',
    'follow-ups-queued',
    'nothing-to-discard',
    'history-changed',
    'command-conflict',
    'command-in-doubt',
  ] satisfies SessionDiscardRefusalReason[])(
    'answers %s as a Conflict with that reason',
    async (reason) => {
      await withBureau(async (opened) => {
        const run = await stoppedTurn(opened, 'anonymous:local');
        const handler = stubbed(opened, async () => {
          throw new SessionDiscardRefusedError(reason, 'refused');
        });

        const body = await call(handler, run.contextId);

        expect(body.error?.data).toMatchObject({ weftCode: 'Conflict', reason });
      });
    },
  );

  it('answers a shutting-down Bureau as Unavailable', async () => {
    await withBureau(async (opened) => {
      const run = await stoppedTurn(opened, 'anonymous:local');
      const handler = stubbed(opened, async () => {
        throw new BureauShuttingDownError(
          'Cannot discard a turn: Bureau is shutting down.',
          '2026-11-18T00:00:00.000Z',
        );
      });

      const body = await call(handler, run.contextId);

      expect(body.error?.data).toMatchObject({ weftCode: 'Unavailable', reason: 'shutting-down' });
    });
  });
});
