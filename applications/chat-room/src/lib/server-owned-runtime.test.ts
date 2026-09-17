import { describe, expect, it } from 'bun:test';
import {
  disposeServerOwnedRuntime,
  durableRuntime,
  installServerOwnedRuntimeTestIsolation,
  peekApproval,
  requestApproval,
  serverOwnedRuntime,
} from './server-owned-runtime-test-helpers';

installServerOwnedRuntimeTestIsolation();

describe('server-owned runtime', () => {
  it('reuses the current HMR slot before serving a request', async () => {
    const previous = serverOwnedRuntime();

    const current = serverOwnedRuntime();

    expect(current).toBe(previous);
    expect(current.store).toBe(previous.store);
    expect(current.sessions).toBe(previous.sessions);
    expect(current.shutdownSignal).toBeInstanceOf(AbortSignal);
    expect(current.durability).toBe('in-memory');
  });

  it('disposes the current HMR slot without dropping its teardowns', async () => {
    const runtime = serverOwnedRuntime();
    let teardownRan = false;
    runtime.onDispose(() => {
      teardownRan = true;
    });

    expect(await disposeServerOwnedRuntime()).toEqual({ failures: 0 });

    expect(teardownRan).toBe(true);
  });

  it('settles pending approvals before runtime teardowns', async () => {
    const runtime = serverOwnedRuntime();

    const pending = requestApproval('hmr-shutdown', {
      toolName: 'remember_note',
      callId: 'call-hmr',
      message: 'Approve the call?',
      arguments: { text: 'current' },
    });
    let teardownSawPending = true;
    runtime.onDispose(() => {
      teardownSawPending = peekApproval('hmr-shutdown') !== undefined;
    });

    expect(peekApproval('hmr-shutdown')?.callId).toBe('call-hmr');
    const disposal = disposeServerOwnedRuntime();

    expect(peekApproval('hmr-shutdown')).toBeUndefined();
    expect(teardownSawPending).toBe(false);
    expect(await disposal).toEqual({ failures: 0 });
    expect(await pending).toBe(false);
  });

  it('aborts pending approvals before the real durable engine teardown starts', async () => {
    const runtime = serverOwnedRuntime();
    await durableRuntime();
    let teardownSawAbort = false;
    runtime.onDispose(() => {
      teardownSawAbort = runtime.shutdownSignal.aborted;
    });
    const pending = requestApproval(
      'conversation-shutdown',
      {
        toolName: 'remember_note',
        callId: 'call-shutdown',
        message: 'May this run?',
        arguments: { text: 'shutdown' },
      },
      runtime.shutdownSignal,
    );

    expect(peekApproval('conversation-shutdown')).toEqual({
      toolName: 'remember_note',
      callId: 'call-shutdown',
      message: 'May this run?',
      arguments: { text: 'shutdown' },
    });

    await disposeServerOwnedRuntime({ drain: true });
    expect(teardownSawAbort).toBe(true);
    expect(await pending).toBe(false);
    expect(peekApproval('conversation-shutdown')).toBeUndefined();
  });

  it('returns one runtime per process rather than one per call', async () => {
    await disposeServerOwnedRuntime();
    const first = serverOwnedRuntime();
    const second = serverOwnedRuntime();

    // Identity, not equality: two stores holding equal data would still be
    // two stores, and the second one's history would be invisible to
    // anything holding the first.
    expect(second).toBe(first);
    expect(second.sessions).toBe(first.sessions);
    await disposeServerOwnedRuntime();
  });

  it('builds a fresh runtime after disposal', async () => {
    await disposeServerOwnedRuntime();
    const before = serverOwnedRuntime();
    await disposeServerOwnedRuntime();
    const after = serverOwnedRuntime();

    expect(after).not.toBe(before);
    await disposeServerOwnedRuntime();
  });

  it('runs teardowns in reverse registration order', async () => {
    await disposeServerOwnedRuntime();
    const runtime = serverOwnedRuntime();
    const order: string[] = [];
    runtime.onDispose(() => {
      order.push('store');
    });
    runtime.onDispose(() => {
      order.push('run');
    });

    await disposeServerOwnedRuntime();

    // Reverse, because a durable run registered after the store it writes
    // to has to stop before that store goes away. Registration order is
    // construction order; disposal is the inverse.
    expect(order).toEqual(['run', 'store']);
  });

  it('runs every teardown even when one throws, and reports the failure', async () => {
    await disposeServerOwnedRuntime();
    const runtime = serverOwnedRuntime();
    const completed: string[] = [];
    runtime.onDispose(() => {
      completed.push('first');
    });
    runtime.onDispose(() => {
      throw new Error('teardown exploded');
    });
    runtime.onDispose(() => {
      completed.push('third');
    });

    const { failures } = await disposeServerOwnedRuntime();

    // A half-disposed runtime is precisely the leak this guards against,
    // so one failing teardown must not strand the rest.
    expect(completed).toEqual(['third', 'first']);
    expect(failures).toBe(1);
  });

  it('isolates a teardown whose failure will not even describe itself', async () => {
    // The diagnostic runs INSIDE the catch that provides isolation, so a
    // rejection whose `toString` throws would escape `runDisposal` and skip
    // every remaining teardown — one failed teardown turning into a shutdown
    // that abandons the rest, which is precisely what isolation exists to
    // prevent. The reporting added to help diagnose failures could otherwise
    // cause a worse one.
    await disposeServerOwnedRuntime();
    const runtime = serverOwnedRuntime();

    const completed: string[] = [];
    runtime.onDispose(() => {
      completed.push('registered-first');
    });
    runtime.onDispose(() => {
      throw {
        toString() {
          throw new Error('this value refuses to be formatted');
        },
      };
    });
    runtime.onDispose(() => {
      completed.push('registered-last');
    });

    const { failures } = await disposeServerOwnedRuntime();

    // Reverse order, and BOTH survivors ran — the one after the hostile
    // teardown and the one before it.
    expect(completed).toEqual(['registered-last', 'registered-first']);
    expect(failures).toBe(1);
  });

  it('awaits asynchronous teardowns before returning', async () => {
    await disposeServerOwnedRuntime();
    const runtime = serverOwnedRuntime();

    // An EXTERNALLY held gate, not `await Promise.resolve()`. Awaiting an
    // already-resolved promise queues the continuation ahead of the caller's
    // own resumption, so `settled` became true either way — the test passed
    // against a regression from `await teardown()` to a bare `teardown()`,
    // which is the entire behaviour its name claims.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    let settled = false;
    runtime.onDispose(async () => {
      await held;
      settled = true;
    });

    const disposal = disposeServerOwnedRuntime();

    let disposed = false;
    void disposal.then(() => {
      disposed = true;
      return undefined;
    });
    // A macrotask, so every microtask has drained. Disposal must still be
    // PENDING: the teardown it is responsible for has not finished.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(false);
    expect(settled).toBe(false);

    release();
    await disposal;

    // Without the await, disposal would resolve while a durable run was
    // still shutting down — reported clean, actually mid-flight.
    expect(settled).toBe(true);
  });

  it('leaves the data it owned alone, and hands the next runtime a fresh store', async () => {
    await disposeServerOwnedRuntime();
    const runtime = serverOwnedRuntime();
    await runtime.store.set('conversation:1', 'a seeded value');
    expect(await runtime.store.get('conversation:1')).toBe('a seeded value');

    await disposeServerOwnedRuntime();

    // NOT deleted. This test used to assert the opposite, and the inversion
    // is the point: disposal used to call `storage.clear()`, which is
    // harmless only because this is `MemoryStorage` and dies with the
    // process anyway. Under the persistent-storage swap this module
    // documents as the single change a durable backing store needs, every
    // SIGTERM would have deleted every session and checkpoint immediately
    // before exiting — a graceful restart as the most destructive thing the
    // process can do.
    //
    // Disposal STOPS things. Deleting data is a fixture concern.
    expect(await runtime.store.get('conversation:1')).toBe('a seeded value');

    // And isolation still comes for free, which is why nothing needed the
    // clear: disposal drops the runtime slot, so the next caller gets a new
    // storage rather than the previous one's contents.
    const next = serverOwnedRuntime();
    expect(next).not.toBe(runtime);
    expect(await next.store.get('conversation:1')).toBeNull();
  });

  it('is safe to dispose when nothing was ever created', async () => {
    await disposeServerOwnedRuntime();
    expect(await disposeServerOwnedRuntime()).toEqual({ failures: 0 });
  });
});
