import { describe, expect, it } from 'bun:test';
import {
  EngineRetirementError,
  UnrecognisedDurableSlotError,
  disposeServerOwnedRuntime,
  durableRuntime,
  expectRejectsWith,
  forgetDurableRuntime,
  installServerOwnedDurableTestIsolation,
  serverOwnedRuntime,
} from './server-owned-durable-test-helpers';

installServerOwnedDurableTestIsolation();

describe('server-owned durable runtime reloads and slot compatibility', () => {
  it('does not build alongside an engine that refused to stop, across chained reloads', async () => {
    // A memo's promise covers the whole retirement-and-build of the evaluation
    // that created it — not just construction. So a later evaluation awaiting
    // it cannot tell "the engine was never built" from "the previous engine
    // refused to die" unless it is told, and those want opposite handling.
    //
    // The reachable shape is OVERLAPPING reloads, and nothing weaker will do:
    // when reloads are sequential, the failing evaluation restores the stale
    // memo on its way out and the next one simply retries the same retirement.
    // It is only when a second evaluation has already replaced the slot token
    // that the first one's restore is declined — leaving the slot holding a
    // REJECTED chain promise, which a plain `.catch(() => undefined)` reads as
    // "nothing to retire". That builds a second engine over the same storage
    // beside one that is still running, which is the condition this memo
    // exists to prevent.
    const slotKey = Symbol.for('cinder.chat-room.server-owned.durable');
    const host = globalThis as Record<symbol, { module: number } | undefined>;
    const restamp = (): void => {
      // 0 is below any real generation, so the slot reads as built by an
      // OLDER evaluation — which is what a reload leaves behind.
      const slot = host[slotKey];
      if (slot !== undefined) slot.module = 0;
    };

    const first = await durableRuntime();

    // The stale engine will not stop, and is held open so the second reload
    // can overlap the first. A shutdown that hangs and then fails is exactly
    // what the retirement path is written for.
    let releaseShutdown: (() => void) | undefined;
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    first.engine.shutdown = async () => {
      await shutdownGate;
      throw new Error('this engine will not stop');
    };

    // Reload one, STARTED not awaited: it parks inside the failing shutdown
    // with its own token installed in the slot.
    restamp();
    const reloadOne = durableRuntime();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Reload two lands on top of it and replaces the token, which is what
    // makes reload one's restore decline.
    restamp();
    const reloadTwo = durableRuntime();

    // Handlers attached BEFORE the gate opens. Both reject, and a rejection
    // with nothing attached to it yet is an unhandled rejection that fails
    // the run on its own — asserting them one after the other leaves the
    // second unattended while the first is awaited.
    const oneSettled = reloadOne.then(
      () => 'resolved' as const,
      (cause: unknown) => cause,
    );
    const twoSettled = reloadTwo.then(
      () => 'resolved' as const,
      (cause: unknown) => cause,
    );

    releaseShutdown?.();

    expect(await oneSettled).toBeInstanceOf(EngineRetirementError);

    // The one that matters. Without the failure surviving the hand-off this
    // is `'resolved'` — a brand new engine running over the same storage as
    // `first`, which never stopped.
    expect(await twoSettled).toBeInstanceOf(EngineRetirementError);

    // Restored so `afterEach` can dispose without the poisoned shutdown.
    first.engine.shutdown = () => Promise.resolve(true);
  });

  it('recognises a retirement failure thrown by a PREVIOUS module evaluation', async () => {
    // The chained-reload test above cannot reach this: it restamps the memo
    // within one evaluation, so every error it produces comes from this
    // evaluation's `EngineRetirementError` class and `instanceof` happens to
    // work. Vite re-evaluating the module creates a NEW class object, and an
    // error from the previous one is not an instance of it — so `instanceof`
    // answers "no" at exactly the moment the answer matters, swallows the
    // failure, and builds a second engine beside one that would not stop.
    //
    // A foreign object carrying the same REGISTRY symbol is precisely what a
    // previous evaluation's error looks like from here: same tag, different
    // constructor. Nothing else reproduces constructor turnover in-process.
    const tag = Symbol.for('cinder.chat-room.server-owned.retirement-failure');
    const fromAnEarlierEvaluation = Object.assign(
      new Error('a stale durable engine could not be shut down'),
      { [tag]: true },
    );

    const slotKey = Symbol.for('cinder.chat-room.server-owned.durable');
    const host = globalThis as Record<symbol, { module: number } | undefined>;
    const restamp = (): void => {
      // 0 is below any real generation, so the slot reads as built by an
      // OLDER evaluation — which is what a reload leaves behind.
      const slot = host[slotKey];
      if (slot !== undefined) slot.module = 0;
    };

    const first = await durableRuntime();

    let releaseShutdown: (() => void) | undefined;
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    first.engine.shutdown = async () => {
      await shutdownGate;
      throw fromAnEarlierEvaluation;
    };

    restamp();
    const reloadOne = durableRuntime();
    await new Promise((resolve) => setTimeout(resolve, 0));

    restamp();
    const reloadTwo = durableRuntime();

    const oneSettled = reloadOne.then(
      () => 'resolved' as const,
      (cause: unknown) => cause,
    );
    const twoSettled = reloadTwo.then(
      () => 'resolved' as const,
      (cause: unknown) => cause,
    );

    releaseShutdown?.();

    // Passed through UNWRAPPED, because it already carries the tag — there is
    // nothing to add by rewrapping an error that is already the right kind.
    expect(await oneSettled).toBe(fromAnEarlierEvaluation);

    // The one that discriminates. Under `instanceof`, the foreign error is
    // not recognised, the failure is swallowed, and this is `'resolved'` —
    // a second engine running beside one that never stopped.
    expect(await twoSettled).toBe(fromAnEarlierEvaluation);

    first.engine.shutdown = () => Promise.resolve(true);
  });

  it('does not let an OLDER evaluation retire the engine a newer one built', async () => {
    // The reverse of every other reload test here, and the direction they all
    // missed: an in-flight request still executing PRE-EDIT code reaches
    // `durableRuntime()` after the new evaluation has installed its slot.
    //
    // Under an identity check — "the slot's token is not mine" — that is
    // indistinguishable from finding a stale slot, so the old caller shut down
    // the engine the new evaluation had just built, rebuilt with its own
    // pre-edit workflow, and overwrote the slot. The edit silently rolled back
    // until some later request rolled it forward, shutting down a healthy
    // engine in each direction. Generations have to be COMPARED, not matched.
    const slotKey = Symbol.for('cinder.chat-room.server-owned.durable');
    const host = globalThis as Record<symbol, { module: number } | undefined>;

    const current = await durableRuntime();

    let shutdowns = 0;
    const realShutdown = current.engine.shutdown.bind(current.engine);
    current.engine.shutdown = () => {
      shutdowns += 1;
      return realShutdown();
    };

    // A very high ordinal stands in for "this slot was installed by an
    // evaluation NEWER than the caller about to run" — the caller here is this
    // module evaluation, whose generation is far below it.
    const slot = host[slotKey];
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    slot.module = Number.MAX_SAFE_INTEGER;

    const served = await durableRuntime();

    // The SAME engine, handed back rather than replaced.
    expect(served).toBe(current);

    // And nothing was retired. Without the ordering check this is 1: a
    // healthy, current engine shut down by a request running old code.
    expect(shutdowns).toBe(0);

    slot.module = 0;
  });

  it('tolerates a slot stamped by a version that used symbols', async () => {
    // The UPGRADE boundary, which every other reload test here steps over:
    // they all write numeric stamps, so they model two evaluations of the
    // current code rather than this code loading over the previous version.
    //
    // The stamp used to be a `symbol`, and the slot outlives the evaluation
    // that wrote it. `symbol > number` does not compare false — it throws
    // `TypeError: Cannot convert a Symbol value to a number` — so during the
    // one reload that installs this code, every request would have failed
    // until the dev server restarted.
    const slotKey = Symbol.for('cinder.chat-room.server-owned.durable');
    const host = globalThis as Record<symbol, { module: unknown } | undefined>;

    const before = await durableRuntime();

    const slot = host[slotKey];
    expect(slot).toBeDefined();
    if (slot === undefined) return;
    slot.module = Symbol('a stamp written by the previous version');

    // Must not throw. An unrecognised stamp reads as OLDER than any real
    // generation, so the slot is retired and rebuilt — which is the correct
    // answer for something a previous evaluation left behind.
    const after = await durableRuntime();
    expect(after).not.toBe(before);
    expect(typeof after.engine.shutdown).toBe('function');
  });

  it('retries retirement once a transient shutdown failure clears', async () => {
    // The half the chained-reload tests never reached: they assert the two
    // initial promises reject and then reset the shutdown method WITHOUT
    // calling `durableRuntime()` again, so nothing checks that the system can
    // recover.
    //
    // It could not. The restore on a chained failure put back `held`, which by
    // then was a previous chain whose promise had already rejected — so every
    // later caller re-awaited that cached rejection and nobody ever called the
    // original engine's `shutdown()` again. A transient failure wedged the
    // route family until the process restarted, which is indistinguishable
    // from a permanent one and much harder to diagnose.
    const slotKey = Symbol.for('cinder.chat-room.server-owned.durable');
    const host = globalThis as Record<symbol, { module: number } | undefined>;
    const restamp = (): void => {
      const slot = host[slotKey];
      if (slot !== undefined) slot.module = 0;
    };

    const first = await durableRuntime();

    // Fails while the condition holds, succeeds after it clears.
    let refusing = true;
    let shutdowns = 0;
    const realShutdown = first.engine.shutdown.bind(first.engine);
    let releaseShutdown: (() => void) | undefined;
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    first.engine.shutdown = async () => {
      shutdowns += 1;
      await shutdownGate;
      if (refusing) throw new Error('transiently unable to stop');
      return realShutdown();
    };

    // Two overlapping reloads, so the failure travels through a CHAIN rather
    // than through the original slot — which is the case that wedged.
    restamp();
    const reloadOne = durableRuntime();
    await new Promise((resolve) => setTimeout(resolve, 0));
    restamp();
    const reloadTwo = durableRuntime();

    const settledOne = reloadOne.then(
      () => 'resolved' as const,
      (cause: unknown) => cause,
    );
    const settledTwo = reloadTwo.then(
      () => 'resolved' as const,
      (cause: unknown) => cause,
    );

    releaseShutdown?.();
    expect(await settledOne).toBeInstanceOf(EngineRetirementError);
    expect(await settledTwo).toBeInstanceOf(EngineRetirementError);

    // The condition clears. A later caller must actually RETRY the shutdown,
    // not re-await the rejection the chain cached.
    refusing = false;
    const before = shutdowns;

    restamp();
    const recovered = await durableRuntime();

    // `shutdown()` was called again — without the original slot being carried
    // through the chain, this stays at `before` and the call below rejects
    // instead of resolving.
    expect(shutdowns).toBeGreaterThan(before);
    expect(recovered).not.toBe(first);
    expect(typeof recovered.engine.shutdown).toBe('function');
  });

  it('refuses a slot left by an incompatible layout rather than building beside it', async () => {
    // Earlier layouts of this slot stored the promise directly, then
    // `{ token, promise }` — neither carries `runtime`. Reading `held.runtime`
    // on one of those yields `undefined`, which compares unequal and silently
    // SKIPS retirement: the caller builds a second engine over the same storage
    // while the original keeps running until the process exits.
    //
    // There is no safe migration, because the engine inside an unreadable slot
    // is unreachable — it cannot be shut down. So this refuses, with an
    // instruction a developer can act on, rather than corrupting quietly.
    const slotKey = Symbol.for('cinder.chat-room.server-owned.durable');
    const host = globalThis as Record<symbol, unknown>;

    await durableRuntime();

    for (const legacy of [
      // `34e7b6f`: the bare promise.
      Promise.resolve({ engine: {}, checkpointStore: {} }),
      // `1adcc95`: token and promise, no runtime.
      { token: Symbol('legacy'), promise: Promise.resolve({ engine: {} }) },
    ]) {
      host[slotKey] = legacy;
      await expectRejectsWith(durableRuntime(), (error) =>
        expect(error).toBeInstanceOf(UnrecognisedDurableSlotError),
      );
    }

    // The message has to be actionable — an error nobody can act on is barely
    // better than the silence it replaced.
    host[slotKey] = { token: Symbol('legacy'), promise: Promise.resolve({}) };
    await expectRejectsWith(durableRuntime(), (error) => {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) expect(error.message).toMatch(/Restart the dev server/);
    });

    forgetDurableRuntime();
  });

  it('does not hand out an engine belonging to a runtime being disposed', async () => {
    const before = await durableRuntime();

    // A teardown registered AFTER the durable one, so reverse order runs it
    // FIRST — the window this test is about. By the time it fires, the
    // runtime slot has already been cleared (disposal clears it before
    // running anything) while the durable memo is still set, because the
    // durable teardown has not reached its `engine.shutdown()` yet.
    //
    // A request landing here takes a fresh `SessionStore` from the new
    // runtime. Handing it the memoised engine would pair that store with an
    // engine and checkpoint store that are being STOPPED.
    //
    // The storage is not the hazard and is not touched: `runDisposal`
    // deliberately leaves it alone so a graceful shutdown cannot erase
    // persistent sessions or checkpoints once the in-memory store is
    // swapped. An earlier version of this comment said it was about to be
    // cleared, describing behaviour that was removed on purpose.
    let during: { engine: unknown } | undefined;
    let sawFreshRuntime = false;
    serverOwnedRuntime().onDispose(async () => {
      sawFreshRuntime = serverOwnedRuntime() !== undefined;
      during = await durableRuntime();
    });

    await disposeServerOwnedRuntime();

    expect(sawFreshRuntime).toBe(true);
    // A DIFFERENT engine: the memo was rejected because its runtime was not
    // the one that call would have been given. Returning `before` here is
    // the defect — and is what an identity-free `if (held !== undefined)`
    // does.
    expect(during).toBeDefined();
    expect(during).not.toBe(before);
  });
});
