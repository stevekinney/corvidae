/**
 * COR-1559 — `bureau.contexts.steer` switches a context to a model its agent allows, by calling
 * `BureauContexts.steer`, and answers with Bureau's own admission outcome as data. Only a
 * context the caller cannot see, or a request that is malformed, is a fault.
 */
import { createAgent } from '@lostgradient/operative';
import { createOperationHandler, unauthenticatedLocalAuthContext } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { BureauShuttingDownError } from '../../create-bureau.ts';
import { waitForCondition } from '../../test';
import { noopTool, OPUS_5, OPUS_5_5, GPT_4_1 } from '../../testing/model-override.test-support.ts';
import { buildBureauHandlerHost, BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import {
  openBureau,
  type OpenedBureau,
  OWNER,
  parkingUntilAborted,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

const SHUT_AT = '2026-10-22T12:00:00.000Z';

const picker = createAgent({
  name: 'picker',
  generate: parkingUntilAborted,
  tools: { noop: noopTool },
  allowedCandidates: [OPUS_5_5, OPUS_5],
});

async function withBureau<T>(body: (opened: OpenedBureau) => Promise<T>): Promise<T> {
  const opened = await openBureau({ agents: { picker } });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

/** A session of the selectable agent whose run is going. */
async function liveSession(opened: OpenedBureau, principal: string = OWNER.alice) {
  const run = await opened.bureau.createRun({ message: 'work', agentName: 'picker', principal });
  await waitForCondition(() => opened.bureau.getRun(run.id)?.status === 'running', 'run started');
  return run;
}

const steer = (
  opened: OpenedBureau,
  contextId: string,
  key: string,
  params: Record<string, unknown> = {},
): Promise<RpcBody> =>
  rpc(
    opened.handler,
    'bureau.contexts.steer',
    { contextId, commandId: 'command-1', override: OPUS_5, ...params },
    key,
  );

describe('bureau.contexts.steer admission outcomes', () => {
  it('answers an admission as data, with the command’s version', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);

      const body = await steer(opened, run.sessionId, 'alice-key');

      expect(body.error).toBeUndefined();
      expect(body.result).toMatchObject({
        outcome: 'accepted',
        command: {
          id: 'command-1',
          sessionId: run.sessionId,
          state: 'accepted',
          configVersion: 1,
          requestedValue: { target: 'model', override: 'claude-opus-5', provider: 'anthropic' },
        },
      });
    });
  });

  it('answers an exact retry as replayed, and a different model under the same command as a conflict', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);
      await steer(opened, run.sessionId, 'alice-key');

      const retry = await steer(opened, run.sessionId, 'alice-key');
      const conflicting = await steer(opened, run.sessionId, 'alice-key', { override: OPUS_5_5 });

      expect(retry.result).toMatchObject({ outcome: 'replayed' });
      expect(conflicting.error).toBeUndefined();
      expect(conflicting.result).toMatchObject({
        outcome: 'conflict',
        conflict: { id: 'command-1', reason: 'requested-value-mismatch' },
      });
    });
  });

  it('answers a model the agent does not allow as rejected with model-not-allowed, not a fault', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);

      const body = await steer(opened, run.sessionId, 'alice-key', { override: GPT_4_1 });

      expect(body.error).toBeUndefined();
      expect(body.result).toMatchObject({
        outcome: 'rejected',
        failure: { reason: 'model-not-allowed' },
      });
    });
  });

  it('answers a stale expectedRevision as rejected with stale-revision, and a current one as accepted', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);
      await steer(opened, run.sessionId, 'alice-key');

      const stale = await steer(opened, run.sessionId, 'alice-key', {
        commandId: 'command-2',
        override: OPUS_5_5,
        expectedRevision: 0,
      });
      const current = await steer(opened, run.sessionId, 'alice-key', {
        commandId: 'command-3',
        override: OPUS_5_5,
        expectedRevision: 1,
      });

      expect(stale.result).toMatchObject({
        outcome: 'rejected',
        failure: { reason: 'stale-revision' },
      });
      expect(current.result).toMatchObject({ outcome: 'accepted' });
    });
  });

  it('admits a model override on an idle context', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);
      opened.bureau.abortRun(run.id);
      await waitForCondition(
        () => opened.bureau.getRun(run.id)?.status !== 'running',
        'run stopped',
      );

      const body = await steer(opened, run.sessionId, 'alice-key');

      expect(body.result).toMatchObject({ outcome: 'accepted' });
    });
  });
});

describe('bureau.contexts.steer faults', () => {
  it('answers a missing context, and another owner’s, as the same not found', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);

      const missing = await steer(opened, 'no-such-context', 'alice-key');
      const foreign = await steer(opened, run.sessionId, 'bob-key');

      expect(missing.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
      expect(foreign.error?.data).toMatchObject({
        weftCode: 'NotFound',
        resource: 'context',
        identifier: run.sessionId,
      });
    });
  });

  it('answers an operator that does not own the context as a missing one, because Bureau admits steering only under the session’s own authority', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);

      const body = await steer(opened, run.sessionId, 'contexts-writer-key');

      expect(body.error?.data).toMatchObject({ weftCode: 'NotFound' });
    });
  });

  it('refuses a request without an override, with a command identifier it cannot use, or with a key it does not declare', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened);

      for (const params of [
        { override: undefined },
        { override: { model: 'claude-opus-5' } },
        { override: { provider: 'anthropic' } },
        { commandId: '' },
        { principal: 'someone-else' },
        { override: { ...OPUS_5, effort: 'high' } },
      ]) {
        const body = await steer(opened, run.sessionId, 'alice-key', params);
        expect(body.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
      }
    });
  });
});

describe('bureau.contexts.steer over a Bureau with a stubbed admission', () => {
  /** The operations served over `bureau`, with the steering verb replaced by `submit`. */
  function stubbed(opened: OpenedBureau, submit: () => Promise<unknown>) {
    const host = buildBureauHandlerHost(opened.bureau, []);
    return createOperationHandler({
      operations: BUREAU_HANDLER_OPERATIONS,
      host: {
        ...host,
        contexts: {
          get: opened.bureau.contexts.get,
          internals: { sessionStore: opened.bureau.internals.sessionStore },
          steer: submit,
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
          method: 'bureau.contexts.steer',
          params: { contextId, commandId: 'c', override: OPUS_5 },
        }),
      }),
    );
    return (await response.json()) as RpcBody;
  };

  it('answers unsupported-capability as data, with its reason', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened, 'anonymous:local');
      const handler = stubbed(opened, async () => ({
        outcome: 'unsupported-capability',
        reason: 'durable-steering-unavailable',
      }));

      const body = await call(handler, run.sessionId);

      expect(body.error).toBeUndefined();
      expect(body.result).toEqual({
        outcome: 'unsupported-capability',
        reason: 'durable-steering-unavailable',
      });
    });
  });

  it('answers Bureau’s shutdown as rejected with shutting-down, not a fault', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened, 'anonymous:local');
      const handler = stubbed(opened, async () => {
        throw new BureauShuttingDownError('Cannot steer: Bureau is shutting down.', SHUT_AT);
      });

      const body = await call(handler, run.sessionId);

      expect(body.error).toBeUndefined();
      expect(body.result).toMatchObject({
        outcome: 'rejected',
        failure: { reason: 'shutting-down', failedAt: SHUT_AT },
      });
    });
  });

  it('answers a not-found admission as a missing context', async () => {
    await withBureau(async (opened) => {
      const run = await liveSession(opened, 'anonymous:local');
      const handler = stubbed(opened, async () => ({ outcome: 'not-found' }));

      const body = await call(handler, run.sessionId);

      expect(body.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
    });
  });
});
