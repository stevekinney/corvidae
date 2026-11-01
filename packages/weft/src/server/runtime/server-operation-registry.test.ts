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

  it('hands a long-poll worker the retried task: the dead attempt left the id tracked and assigned, and the retry releases both', async () => {
    using engine = new Engine({ storage: new FailingTerminalCommitStorage('op-poll') });
    const configuration = resolveNetworkConfig({
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
      trustedHosts: ['localhost'],
    });
    const { serverOptions } = configuration;
    const context = buildServerContext(serverOptions, configuration.serverMetricsCollector);
    using _taskQueue = context.taskQueue;
    await context.taskLedgerRecovery.ready;
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

    // No WebSocket worker is connected, so the task falls back to the long-poll queue.
    expect(
      await dispatchTaskImpl(context, serverOptions, {
        operationId: 'op-poll',
        workflowType: 'test',
        activityName: 'test.charge',
        queue: 'default',
        input: null,
      }),
    ).toBe(true);
    const claimed = await poll();
    expect(claimed.status).toBe(200);
    const { attemptToken, workerId } = (await claimed.json()) as {
      attemptToken: string;
      workerId: string;
    };

    // The storage fails the terminal commit, so the result dead-letters. The
    // long-poll transport does not release the task queue's tracking for a dead
    // letter (`applyTaskResult`), which is what a retry has to undo.
    const resultUrl = new URL('http://localhost/v1/tasks/default/result');
    const submitted = await handleTaskResultRequest(
      context,
      serverOptions,
      new Request(resultUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationId: 'op-poll',
          workerId,
          attemptToken,
          status: 'completed',
        }),
      }),
      resultUrl,
      worker,
    );
    expect(submitted?.status).toBe(200);
    expect(decodeRemoteTaskRecord(await engine.storage.get(taskLedgerKey('op-poll')))?.state).toBe(
      'deadLettered',
    );
    expect(context.taskQueue.isTracked('op-poll')).toBe(true);
    expect(context.registry.isAssigned('op-poll')).toBe(true);

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
});
