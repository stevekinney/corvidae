import { describe, expect, it, spyOn } from 'bun:test';

import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { createServerWebSocketHandlers } from './authentication-bridge.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';

import type { RemoteTaskLeased } from '../../core/task-ledger/task-ledger-types.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
} from '../../core/task-ledger/task-ledger.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';

type FakeWorkerSocket = {
  data: WebSocketData;
};

function createWorkerSocket(workerId: string): FakeWorkerSocket {
  return {
    data: {
      connectionType: 'worker',
      pathname: '/v1/tasks/default/stream',
      queue: 'default',
      workerId,
    },
  };
}

function leasedFixture(overrides: Partial<RemoteTaskLeased> = {}): RemoteTaskLeased {
  return {
    recordVersion: 1,
    operationId: 'op-disconnect',
    workflowType: 'checkout',
    workflowExecutionToken: 'token-1',
    activityName: 'charge',
    queue: 'default',
    input: { amount: 100 },
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
    generation: 1,
    state: 'leased',
    attemptToken: 'attempt-1',
    workerSessionId: 'worker-1',
    attempt: 1,
    leaseDeadline: Date.now() + 60_000,
    firstQueuedAt: 1_000,
    lastQueuedAt: 1_000,
    startedAt: 2_000,
    lastHeartbeatAt: 2_000,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

describe('createServerWebSocketHandlers', () => {
  it('ignores stale worker close events after the worker already reconnected', () => {
    const context = minimalServerContext();
    const handlers = createServerWebSocketHandlers(context, minimalServeOptions(), () => {});
    const staleSocket = createWorkerSocket('worker-1');
    const freshSocket = createWorkerSocket('worker-1');
    context.workerSockets.set('worker-1', freshSocket as never);

    using warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    handlers.close(staleSocket as never);

    expect(warnSpy).toHaveBeenCalledWith(
      '[weft] Ignoring stale socket close for worker "worker-1" — already reconnected',
    );
    expect(context.workerSockets.get('worker-1') as unknown).toBe(freshSocket);
    expect(context.pendingWorkerRequeues.size).toBe(0);
  });

  it('requeues a live, unexpired lease when its worker disconnects', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const socket = createWorkerSocket('worker-1');
    context.workerSockets.set('worker-1', socket as never);

    context.registry.assignTask('worker-1', 'op-disconnect', 30_000, undefined, 'attempt-1');
    const leased = leasedFixture();
    await options.engine.storage.put(
      taskLedgerKey('op-disconnect'),
      encodeRemoteTaskRecord(leased),
    );

    const handlers = createServerWebSocketHandlers(context, options, () => {});
    handlers.close(socket as never);

    // The reassignment runs in a fire-and-forget async task per in-flight
    // task, now several awaits deep (COR-205's attempt-record disposition
    // update reads the prior attempt's record before writing its update,
    // atomically alongside the ledger requeue) — poll for the durable
    // effect rather than hardcoding a microtask-flush count that would
    // silently under-wait again the next time this chain grows by one hop.
    await waitForCondition(
      async () => {
        const record = decodeRemoteTaskRecord(
          await options.engine.storage.get(taskLedgerKey('op-disconnect')),
        );
        return record?.state === 'queued';
      },
      { label: 'worker-disconnect requeue committed' },
    );

    const record = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey('op-disconnect')),
    );
    expect(record?.state).toBe('queued');
    if (record?.state === 'queued') {
      expect(record.attempt).toBe(2);
      expect(record.lastRequeueReason).toBe('worker-disconnect');
    }

    // The ledger commit above only marks the record `queued`; the actual
    // re-enqueue onto `context.taskQueue` (which arms a pending-task
    // expiration timer, default TTL 5 minutes) happens later, off a separate
    // `scheduleDelayedDispatch` timer (task-dispatch.ts). Wait for it to
    // land before disposing, or a dispose that races ahead of it leaves the
    // timer armed on an already-disposed queue with nothing left to clear it.
    await waitForCondition(() => context.taskQueue.isTracked('op-disconnect'), {
      label: 'worker-disconnect redispatch re-enqueued',
    });
    // `minimalServerContext()` is a bare fixture with no server shutdown path
    // to clear this timer on its own, so dispose it directly.
    context.taskQueue[Symbol.dispose]();
  });

  it('does not arm a reconnect-grace timer for a close event received while the server is stopping (COR-1343)', () => {
    // Regression: serve-internals.ts's shutdown disposer sets context.stopping
    // and clears context.pendingWorkerRequeues BEFORE later-registered
    // disposers (shutdownAllWorkers, then the Bun server's own forced socket
    // close) run — see registerStackDisposers' "Registered last — disposed
    // first" ordering. A worker socket that closes as part of THAT later
    // teardown reaches this close() handler with context.stopping already
    // true. Before this fix, close() never checked that flag, so it still
    // scheduled a fresh grace-period timer here — one nothing would ever
    // clear again, since the timer-clearing disposer had already run. That
    // showed up as a real timer outliving `server.stop()` under
    // WEFT_STRICT_TIMER_LEAK_GUARD=1 (src/server/index.test.ts's "stop
    // drains connected workers..." test).
    const context = minimalServerContext();
    // workerReconnectGracePeriodMs is readonly on ServerContext (set once by
    // serve()'s options resolution); only a test can still poke past that to
    // exercise the nonzero-grace-period branch this bug lives in.
    (context as { workerReconnectGracePeriodMs: number }).workerReconnectGracePeriodMs = 2_000;
    const options = minimalServeOptions();
    const socket = createWorkerSocket('worker-stopping');
    context.workerSockets.set('worker-stopping', socket as never);
    context.registry.assignTask('worker-stopping', 'op-stopping', 30_000, undefined, 'attempt-1');

    context.stopping = true;
    const handlers = createServerWebSocketHandlers(context, options, () => {});
    handlers.close(socket as never);

    expect(context.pendingWorkerRequeues.size).toBe(0);
  });
});
