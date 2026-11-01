import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { Engine } from '../../core/engine.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskDeadLettered,
} from '../../core/task-ledger/task-ledger.ts';
import {
  manifestForActivities,
  TEST_ACCEPTED_MANIFEST_DIGEST,
} from '../../worker/registry-fixtures.test-support.ts';
import { executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { buildServerContext, resolveNetworkConfig } from '../serve-internals.ts';
import { FailingTerminalCommitStorage } from './server-context.test-support.ts';
import { dispatchTaskImpl } from './task-dispatch.ts';
import { handleTaskPollRequest } from './task-polling.ts';
import { handleTaskResultRequest } from './task-result-submission.ts';

function deadLetteredRecord(operationId: string): RemoteTaskDeadLettered {
  return {
    recordVersion: 1,
    operationId,
    workflowType: 'test',
    activityName: 'test.charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 0,
    generation: 3,
    state: 'deadLettered',
    attemptToken: 'attempt-token',
    attempt: 1,
    pendingStatus: 'completed',
    pendingResultDigest: 'digest',
    retryCount: 0,
    requeueCount: 0,
    deadLetteredAt: 1,
    persistenceFailureReason: 'lost the compare-and-swap race',
  };
}

describe('the operation registry serve() builds', () => {
  it('dispatches a task weft.tasks.deadletters.retry queued, without waiting for the ledger sweep', async () => {
    using engine = new Engine({ storage: new MemoryStorage() });
    const configuration = resolveNetworkConfig({
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
      trustedHosts: ['localhost'],
    });
    const context = buildServerContext(
      configuration.serverOptions,
      configuration.serverMetricsCollector,
    );
    await context.taskLedgerRecovery.ready;
    context.registry.register({
      manifest: manifestForActivities(['test.charge']),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: 'w-1',
      queue: 'default',
      activities: ['test.charge'],
      concurrency: 5,
    });
    const sent: string[] = [];
    context.workerSockets.set('w-1', { send: (message: string) => sent.push(message) } as never);
    await engine.storage.put(
      taskLedgerKey('op-live'),
      encodeRemoteTaskRecord(deadLetteredRecord('op-live')),
    );

    const result = await executeOperation(
      'weft.tasks.deadletters.retry',
      { operationId: 'op-live' },
      {
        principal: principalFromApiKey({ subject: 'operator', scopes: ['system:admin'] }),
        host: engine,
        transport: 'http-rest',
        registry: context.liveOperationRegistry,
      },
    );

    expect(result.ok).toBe(true);
    // The worker is handed the task by the dispatcher the hook scheduled.
    await waitUntil(
      async () =>
        decodeRemoteTaskRecord(await engine.storage.get(taskLedgerKey('op-live')))?.state ===
        'leased',
      { message: 'the retried task to be claimed' },
    );
    expect(sent).toHaveLength(1);
    const metric = configuration.serverMetricsCollector.snapshot()['weft.task.requeues'];
    expect(metric?.type === 'counter' && metric.value).toBe(1);
  });

  /**
   * A server whose `op-poll` terminal commit fails, so a long-poll result for it
   * dead-letters, and a `claim()` that drives the real long-poll flow:
   * dispatch, poll, claim.
   */
  function longPollFixture(failingOperationId: string) {
    const engine = new Engine({ storage: new FailingTerminalCommitStorage(failingOperationId) });
    const configuration = resolveNetworkConfig({
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
      trustedHosts: ['localhost'],
    });
    const { serverOptions } = configuration;
    const context = buildServerContext(serverOptions, configuration.serverMetricsCollector);
    const worker = principalFromApiKey({ subject: 'worker', scopes: ['workers:write'] });
    const poll = async () => {
      const url = new URL('http://localhost/v1/tasks/default?activity=test.charge&timeout=0');
      const response = await handleTaskPollRequest(
        context,
        serverOptions,
        new Request(url, { method: 'GET' }),
        url,
        worker,
      );
      if (response === null) throw new Error('Expected the long-poll route to answer');
      return response;
    };
    const submit = async (body: Record<string, unknown>) => {
      const resultUrl = new URL('http://localhost/v1/tasks/default/result');
      const response = await handleTaskResultRequest(
        context,
        serverOptions,
        new Request(resultUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        resultUrl,
        worker,
      );
      if (response === null) throw new Error('Expected the result route to answer');
      return response;
    };
    const dispatch = (operationId: string) =>
      dispatchTaskImpl(context, serverOptions, {
        operationId,
        workflowType: 'test',
        activityName: 'test.charge',
        queue: 'default',
        input: null,
      });
    // No WebSocket worker is connected, so a dispatched task falls back to the long-poll queue.
    const claim = async (operationId: string) => {
      expect(await dispatch(operationId)).toBe(true);
      const claimed = await poll();
      expect(claimed.status).toBe(200);
      const body = (await claimed.json()) as {
        operationId: string;
        attemptToken: string;
        workerId: string;
      };
      expect(body.operationId).toBe(operationId);
      return body;
    };
    return { engine, context, poll, submit, claim };
  }

  it('releases a long-poll dead letter when it is dead-lettered, so the next task is claimed, and a retry still reaches the worker', async () => {
    const { engine, context, poll, submit, claim } = longPollFixture('op-poll');
    using _engine = engine;
    using _taskQueue = context.taskQueue;
    await context.taskLedgerRecovery.ready;

    const { attemptToken, workerId } = await claim('op-poll');
    expect(context.taskQueue.isTracked('op-poll')).toBe(true);
    expect(context.registry.isAssigned('op-poll')).toBe(true);

    // The storage fails the terminal commit, so the result dead-letters.
    const submitted = await submit({
      operationId: 'op-poll',
      workerId,
      attemptToken,
      status: 'completed',
    });
    expect(submitted.status).toBe(200);
    expect(decodeRemoteTaskRecord(await engine.storage.get(taskLedgerKey('op-poll')))?.state).toBe(
      'deadLettered',
    );
    // The dead attempt is over: the server no longer tracks the id or holds its slot.
    expect(context.taskQueue.isTracked('op-poll')).toBe(false);
    expect(context.registry.isAssigned('op-poll')).toBe(false);

    // Nothing retried or cleared the dead letter, and the next task is still claimed.
    await claim('op-next');

    const result = await executeOperation(
      'weft.tasks.deadletters.retry',
      { operationId: 'op-poll' },
      {
        principal: principalFromApiKey({ subject: 'operator', scopes: ['system:admin'] }),
        host: engine,
        transport: 'http-rest',
        registry: context.liveOperationRegistry,
      },
    );
    expect(result.ok).toBe(true);

    let retried: Response | undefined;
    await waitUntil(
      async () => {
        retried = await poll();
        return retried.status === 200;
      },
      { message: 'the long-poll worker to be handed the retried task' },
    );
    const body = (await retried?.json()) as { operationId: string; attempt: number };
    expect(body.operationId).toBe('op-poll');
    expect(body.attempt).toBe(2);
  });

  it('releases a long-poll task whose oversized result is rejected, whether or not the rejection persists', async () => {
    const { engine, context, submit, claim } = longPollFixture('op-oversize-dead');
    using _engine = engine;
    using _taskQueue = context.taskQueue;
    await context.taskLedgerRecovery.ready;
    (context as { payloadSizeMaxBytes: number | null }).payloadSizeMaxBytes = 64;

    for (const operationId of ['op-oversize-applied', 'op-oversize-dead']) {
      const { attemptToken, workerId } = await claim(operationId);
      const response = await submit({
        operationId,
        workerId,
        attemptToken,
        status: 'completed',
        value: { blob: 'x'.repeat(200) },
      });
      expect(response.status).toBe(413);
      expect(context.taskQueue.isTracked(operationId)).toBe(false);
      expect(context.registry.isAssigned(operationId)).toBe(false);
    }
    // The second one's substitute failure could not be persisted.
    expect(
      decodeRemoteTaskRecord(await engine.storage.get(taskLedgerKey('op-oversize-dead')))?.state,
    ).toBe('deadLettered');
  });
});
