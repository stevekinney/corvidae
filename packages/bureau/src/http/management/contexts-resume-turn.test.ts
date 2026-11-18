/**
 * COR-2437 — `bureau.contexts.resumeturn` answers each refusal of the Bureau's as a `Conflict` with
 * its reason, a run the context does not have as `NotFound`, and another owner's context exactly
 * as a missing one, whatever run it names. A turn that goes on is `session-resume.test.ts`'s and
 * `workspace-context-privacy.test.ts`'s.
 */
import { createAgent } from '@lostgradient/operative';
import { createOperationHandler, unauthenticatedLocalAuthContext } from '@lostgradient/backchannel';
import { describe, expect, it } from 'bun:test';

import {
  SessionResumeRefusedError,
  type SessionResumeRefusalReason,
} from '../../session-resume.ts';
import { waitForCondition, waitForTaskState } from '../../test';
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
  generate: async () => ({ content: 'the answer', toolCalls: [] }),
});

async function withBureau<T>(body: (opened: OpenedBureau) => Promise<T>): Promise<T> {
  const opened = await openBureau({ agents: { agent } });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

/** A finished turn of `principal`'s, once its record has settled. */
async function finishedTurn(opened: OpenedBureau, principal: string = OWNER.alice) {
  const run = await opened.bureau.tasks.start('agent', 'go', { principal });
  await waitForTaskState(opened.bureau, run.id);
  await waitForCondition(async () => {
    const record = await opened.bureau.internals.taskRegistry.record(run.id);
    return record?.settled !== undefined;
  }, 'the run has ended');
  return run;
}

const resumeCall = (
  opened: OpenedBureau,
  contextId: string,
  key: string,
  params: Record<string, unknown> = {},
): Promise<RpcBody> =>
  rpc(
    opened.handler,
    'bureau.contexts.resumeturn',
    { contextId, commandId: 'resume-1', runId: 'unset', ...params },
    key,
  );

describe('bureau.contexts.resumeturn', () => {
  it('answers the owner the Bureau’s reason, and changes nothing', async () => {
    await withBureau(async (opened) => {
      const run = await finishedTurn(opened);
      const before = await opened.bureau.contexts.get(run.contextId);

      const body = await resumeCall(opened, run.contextId, 'alice-key', { runId: run.id });
      const unknown = await resumeCall(opened, run.contextId, 'alice-key', {
        runId: 'no-such-run',
      });

      expect(body.error?.data).toMatchObject({ weftCode: 'Conflict', reason: 'turn-finished' });
      expect(unknown.error?.data).toMatchObject({
        weftCode: 'NotFound',
        resource: 'run',
        identifier: 'no-such-run',
      });
      expect(await opened.bureau.contexts.get(run.contextId)).toEqual(before);
    });
  });

  it('answers another owner’s context and a missing one as the same not found, whatever the run', async () => {
    await withBureau(async (opened) => {
      const run = await finishedTurn(opened);

      const real = await resumeCall(opened, run.contextId, 'bob-key', { runId: run.id });
      const random = await resumeCall(opened, run.contextId, 'bob-key', { runId: 'no-such-run' });
      const missing = await resumeCall(opened, 'no-such-context', 'alice-key', { runId: run.id });

      for (const body of [real, random, missing]) {
        expect(body.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
      }
      expect(real.error).toEqual(random.error);
    });
  });

  // COR-2437 review: resume is owner only. The continuation runs as the owner's chat, so an
  // operator, whatever scopes it holds, is answered as for a missing context and starts nothing.
  it('answers an operator holding read and write exactly as for a missing context', async () => {
    await withBureau(async (opened) => {
      const run = await finishedTurn(opened);

      const operator = await resumeCall(opened, run.contextId, 'operator-key', { runId: run.id });
      const missing = await resumeCall(opened, 'no-such-context', 'operator-key', {
        runId: run.id,
      });

      expect(operator.error?.data).toMatchObject({ weftCode: 'NotFound', resource: 'context' });
      expect(operator.error?.data).toMatchObject({
        weftCode: missing.error?.data?.['weftCode'],
        resource: missing.error?.data?.['resource'],
      });
    });
  });

  it('refuses a request without a command or a run, or with a key it does not declare', async () => {
    await withBureau(async (opened) => {
      const run = await finishedTurn(opened);

      for (const params of [
        { commandId: '', runId: run.id },
        { runId: '' },
        { runId: undefined },
        { runId: run.id, owner: 'someone-else' },
      ]) {
        const body = await resumeCall(opened, run.contextId, 'alice-key', params);
        expect(body.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
      }
    });
  });
});

describe('bureau.contexts.resumeturn refusals', () => {
  it.each([
    'not-latest-turn',
    'turn-running',
    'turn-awaiting-person',
    'turn-recovering',
    'turn-finished',
    'run-not-resumable',
    'turn-interrupted-call',
    'follow-up-delivered',
    'follow-ups-queued',
    'nothing-to-resume',
    'command-conflict',
  ] satisfies SessionResumeRefusalReason[])(
    'answers %s as a Conflict with that reason',
    async (reason) => {
      await withBureau(async (opened) => {
        const run = await finishedTurn(opened, 'anonymous:local');
        const host = buildBureauHandlerHost(opened.bureau, []);
        const handler = createOperationHandler({
          operations: BUREAU_HANDLER_OPERATIONS,
          host: {
            ...host,
            contexts: {
              get: opened.bureau.contexts.get,
              internals: { sessionStore: opened.bureau.internals.sessionStore },
              resumeTurn: async () => {
                throw new SessionResumeRefusedError(reason, 'refused');
              },
            } as never,
          },
          authenticate: async () => ({
            method: 'unauthenticated-local' as const,
            principal: unauthenticatedLocalAuthContext().principal!,
          }),
          publicPaths: [],
        });

        const response = await handler(
          new Request('http://localhost/jsonrpc', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'bureau.contexts.resumeturn',
              params: { contextId: run.contextId, commandId: 'c', runId: 'r' },
            }),
          }),
        );
        const body = (await response.json()) as RpcBody;

        expect(body.error?.data).toMatchObject({ weftCode: 'Conflict', reason });
      });
    },
  );
});
