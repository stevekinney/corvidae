import { createSessionInputDeliveryStore } from '@lostgradient/operative';
import { MemoryStorage, textValueStore, type Mailbox } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  createSessionInputContinuation,
  OPEN_SESSION_INPUT_STATES,
} from './session-input-continuation';
import {
  createSessionInputMailbox,
  SESSION_INPUT_DELIVERY_RETENTION_MS,
} from './session-input-durability';

/**
 * COR-1476 — admission versus a run's termination, with every interleaving
 * forced by a test seam rather than by timing. The seam is a mailbox whose
 * `list` can hold a read after it has returned, so a test decides exactly what
 * happens between the ending run reading the mailbox and acting on what it read.
 */

const SESSION_ID = 'ordering-session';
const MARKER_PREFIX = 'session-input-open:v1:';

function deferred<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

function fixture() {
  const storage = new MemoryStorage();
  const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
  const mailbox = createSessionInputMailbox(storage, SESSION_ID, 100);
  const started: string[] = [];
  let live: string[] = [];
  let skip = 0;
  let hold:
    | { reached: ReturnType<typeof deferred<void>>; proceed: ReturnType<typeof deferred<void>> }
    | undefined;

  // The seam: the next `list` that returns nothing is held after it returns.
  const seamMailbox = new Proxy(mailbox, {
    get(target, property, receiver) {
      if (property === 'list') {
        return async (...args: Parameters<Mailbox['list']>) => {
          const result = await target.list(...args);
          if (hold !== undefined && result.length === 0) {
            if (skip > 0) {
              skip -= 1;
              return result;
            }
            const current = hold;
            hold = undefined;
            current.reached.resolve();
            await current.proceed.promise;
          }
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  let runCounter = 0;
  const continuation = createSessionInputContinuation({
    kv,
    deliveryStore: createSessionInputDeliveryStore(kv, {
      retentionMs: SESSION_INPUT_DELIVERY_RETENTION_MS,
      nowMs: () => Date.now(),
    }),
    nowMs: () => Date.now(),
    incarnationOf: () => Promise.resolve('incarnation-1'),
    liveRunIds: () => Promise.resolve(live),
    mailboxOf: () => seamMailbox,
    startContinuation: (_sessionId, runId) => {
      started.push(runId);
      // The continuation is live as soon as it starts.
      live = [runId];
      return Promise.resolve();
    },
    newRunId: () => `continuation-${(runCounter += 1)}`,
    isRunLive: (_sessionId, _incarnation, runId) => Promise.resolve(live.includes(runId)),
    isClosed: () => false,
    diagnose: () => {},
  });

  /** What a submit does: marker first, then the admission. */
  async function admit(id: string) {
    await continuation.markOpen(SESSION_ID);
    await admitOnly(id);
  }
  async function admitOnly(id: string) {
    await mailbox.admit({
      caller: 'alice',
      target: SESSION_ID,
      kind: 'session-input:steer',
      payload: { form: 'inline', value: { incarnation: 'incarnation-1', payload: id } },
      idempotencyKey: id,
    });
  }

  return {
    kv,
    mailbox,
    continuation,
    started,
    admit,
    admitOnly,
    setLive: (runIds: string[]) => {
      live = runIds;
    },
    /** Holds the Nth (default first) empty read after it returns. */
    holdNextEmptyRead: (empty = 1) => {
      skip = empty - 1;
      hold = { reached: deferred(), proceed: deferred() };
      return hold;
    },
    markers: () => kv.list(MARKER_PREFIX),
    openCount: async () => {
      const open = await mailbox.list({ states: OPEN_SESSION_INPUT_STATES, limit: 10 });
      return open.length;
    },
  };
}

describe('admission versus a run ending (COR-1476)', () => {
  it('answers an input admitted after the ending run read an empty mailbox and before it removed the marker', async () => {
    const f = fixture();
    // The session has had input before, so it has a marker; the run is ending.
    await f.continuation.markOpen(SESSION_ID);
    const seam = f.holdNextEmptyRead();

    // The ending run read the marker (version 1) and an EMPTY mailbox, and stops there.
    const ending = f.continuation.reconcile(SESSION_ID, { runId: 'run-1', outcome: 'completed' });
    await seam.reached.promise;

    // Now input X is admitted (marker first, then the mailbox), no run is live,
    // and X's own reconcile runs, as `submitSessionInput` does after admitting.
    await f.admit('input-x');
    await f.continuation.reconcile(SESSION_ID);
    expect(f.started).toEqual(['continuation-1']);

    // The ending run resumes and tries to remove the marker it read: it lost,
    // because the marker changed and the mailbox is no longer idle.
    seam.proceed.resolve();
    await ending;

    expect(f.started).toEqual(['continuation-1']);
    expect(await f.markers()).toHaveLength(1);
    expect(await f.openCount()).toBe(1);
  });

  it('answers an input whose marker bump landed before the ending run read it, when the admission lands after the run read the mailbox', async () => {
    const f = fixture();
    // X's marker bump lands first, so the version the ending run reads is current.
    await f.continuation.markOpen(SESSION_ID);
    // The run's first mailbox read passes empty; the second, inside its marker
    // removal, is held after it returns empty.
    const seam = f.holdNextEmptyRead(2);
    const ending = f.continuation.reconcile(SESSION_ID, { runId: 'run-1', outcome: 'completed' });
    await seam.reached.promise;

    // The admission commits only now. The marker is unchanged since the run read
    // it, so its delete will succeed: the marker is NOT what protects X.
    await f.admitOnly('input-x');
    seam.proceed.resolve();
    await ending;
    expect(await f.markers()).toHaveLength(0);
    expect(f.started).toEqual([]);

    // X's reconcile, which runs after its admission whether or not the session is
    // listed, finds the open input, re-creates the marker, and starts the run.
    await f.continuation.reconcile(SESSION_ID);
    expect(f.started).toHaveLength(1);
    expect(await f.markers()).toHaveLength(1);
    expect(await f.openCount()).toBe(1);
  });

  it('starts exactly one continuation when the ending run and the submit side reconcile at once', async () => {
    const f = fixture();
    await f.admit('input-x');
    await Promise.all([
      f.continuation.reconcile(SESSION_ID, { runId: 'run-1', outcome: 'completed' }),
      f.continuation.reconcile(SESSION_ID),
      f.continuation.reconcile(SESSION_ID),
    ]);
    expect(f.started).toHaveLength(1);
  });

  it('heals a crash between the marker and the admission: the sweep removes the marker over an empty mailbox', async () => {
    const f = fixture();
    await f.continuation.markOpen(SESSION_ID);
    expect(await f.markers()).toHaveLength(1);

    await f.continuation.sweep();

    expect(await f.markers()).toHaveLength(0);
    expect(f.started).toEqual([]);
  });

  it('finds input admitted with its marker through the sweep when no reconcile ever ran', async () => {
    const f = fixture();
    await f.admit('input-x');

    await f.continuation.sweep();

    expect(f.started).toHaveLength(1);
  });

  it('does not remove a marker over an open input', async () => {
    const f = fixture();
    await f.admit('input-x');
    f.setLive(['some-other-run']);

    await f.continuation.sweep();

    expect(await f.markers()).toHaveLength(1);
    expect(f.started).toEqual([]);
  });
});
