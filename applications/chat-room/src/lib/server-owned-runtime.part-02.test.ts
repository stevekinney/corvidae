import { describe, expect, it } from 'bun:test';
import {
  RuntimeTerminatingError,
  disposeServerOwnedRuntime,
  installServerOwnedRuntimeTestIsolation,
  requestApproval,
  serverOwnedRuntime,
} from './server-owned-runtime-test-helpers';

installServerOwnedRuntimeTestIsolation();

/**
 * SIGTERM still terminates the process.
 *
 * Registering a listener for a signal REPLACES Node's default behaviour for
 * it, which is to terminate. A handler that starts a cleanup and returns
 * therefore absorbs the signal: with anything holding the event loop open —
 * an HTTP server in a deployment, the interval in the fixture — the process
 * keeps running until whatever sent SIGTERM gives up and sends SIGKILL. That
 * is strictly worse than having registered no handler at all, and it is what
 * the first version of these handlers did.
 *
 * Driven in a CHILD process for the obvious reason: the property under test
 * is that a process dies, and this one has assertions left to run. No explicit
 * timeout — a child that never exits fails on the runner's own default, which
 * is the correct report rather than a number invented here.
 */
describe('overlapping disposal', () => {
  it('joins a disposal already in flight rather than reporting nothing to do', async () => {
    const runtime = serverOwnedRuntime();

    // A teardown that parks, standing in for the asynchronous engine shutdown
    // and checkpoint flush a real disposal awaits.
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    runtime.onDispose(async () => {
      await parked;
      finished = true;
    });

    const first = disposeServerOwnedRuntime();
    const second = disposeServerOwnedRuntime();

    // The assertion that matters is about the SECOND caller alone: it must not
    // settle while the first disposal is still working. Awaiting both would
    // pass either way, since the first one finishes the teardown regardless —
    // which is exactly how the first version of this test managed to pass
    // against the unfixed code.
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
      return undefined;
    });

    // A macrotask, so every pending microtask has run. Without the memo the
    // second call returns `{ failures: 0 }` immediately — the first has already
    // cleared the runtime slot — and would have settled by now. From a signal
    // handler that is `process.exit` firing while the first teardown is still
    // awaiting a checkpoint flush.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondSettled).toBe(false);
    expect(finished).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(finished).toBe(true);
  });
});

it('refuses to build a runtime once a terminating disposal has started', async () => {
  const first = serverOwnedRuntime();

  // A teardown that reaches for a runtime, standing in for an in-flight
  // request landing after the slot is cleared and before the teardowns
  // finish. Under a TERMINATING disposal it is refused rather than served.
  let refusal: unknown;
  first.onDispose(() => {
    try {
      serverOwnedRuntime();
    } catch (cause) {
      refusal = cause;
      throw cause;
    }
  });

  const { failures } = await disposeServerOwnedRuntime({ drain: true });

  // Refused, and counted. The earlier version of this let the teardown build
  // a replacement and relied on a bounded drain to catch it — which could not
  // work: a loop that ends by giving up leaves the last generation
  // undisposed, and the signal handler exits the moment it returns.
  expect(refusal).toBeInstanceOf(RuntimeTerminatingError);
  expect(failures).toBe(1);

  // And nothing was left behind for the exit to cut off.
  expect(() => serverOwnedRuntime()).toThrow(RuntimeTerminatingError);
});

it('drains a replacement created while an ordinary disposal was still running', async () => {
  // The window: an ordinary disposal clears the runtime slot and parks in a
  // teardown; a request builds a replacement; THEN the signal arrives. The
  // terminating call finds a disposal already in flight and joins it — but
  // that promise is an ordinary disposal's, and it has never heard of the
  // replacement. Returning the moment it settles reports "shut down" while a
  // live runtime sits in the slot, and the signal handler exits on top of it.
  const first = serverOwnedRuntime();

  let release!: () => void;
  const heldOpen = new Promise<void>((resolve) => {
    release = resolve;
  });
  first.onDispose(() => heldOpen);

  // ORDINARY: no drain, so no latch — which is what leaves the door open for
  // the replacement below.
  const ordinary = disposeServerOwnedRuntime();

  // The slot is cleared synchronously, so this is a genuinely new runtime,
  // admitted before any latch is set.
  const replacement = serverOwnedRuntime();
  expect(replacement).not.toBe(first);

  let replacementDisposed = false;
  let replacementTeardownSawAbort = false;
  replacement.onDispose(() => {
    replacementTeardownSawAbort = replacement.shutdownSignal.aborted;
    replacementDisposed = true;
  });
  const replacementPending = requestApproval(
    'replacement-shutdown',
    {
      toolName: 'remember_note',
      callId: 'replacement-call',
      message: 'May this run?',
      arguments: { text: 'replacement' },
    },
    replacement.shutdownSignal,
  );

  // The signal lands here. Started, not awaited: it is about to join
  // `ordinary`, which is parked on the gate this test still holds.
  const terminating = disposeServerOwnedRuntime({ drain: true });

  release();
  await ordinary;
  await terminating;

  // Without the drain-after-join, this is false: the terminating call
  // returned `ordinary`'s result and the replacement was never touched.
  expect(replacementDisposed).toBe(true);
  expect(replacementTeardownSawAbort).toBe(true);
  expect(await replacementPending).toBe(false);

  // And the latch still holds afterwards, so nothing refilled the slot on
  // the way out.
  expect(() => serverOwnedRuntime()).toThrow(RuntimeTerminatingError);
});

it('holds every terminating caller behind the replacement teardown', async () => {
  // Two signals can land together — a terminal sending SIGINT alongside
  // SIGTERM, or a supervisor signalling twice. Both join the same in-flight
  // ordinary disposal and both resume when it settles. The first starts the
  // drain, which clears the runtime slot SYNCHRONOUSLY, so the second finds
  // an empty slot.
  //
  // An empty slot is not the same as a finished shutdown. Treating it as one
  // resolves the second caller while the replacement's teardown is still
  // running, and whichever caller the signal handler happens to be awaiting
  // then exits mid-teardown — cutting off exactly the checkpoint flush the
  // drain was added to protect.
  //
  // This asserts the SECOND caller specifically, and deliberately does not
  // use `Promise.all`: awaiting both together makes the first caller's
  // correct timing mask the second's premature resolution, which is how an
  // earlier version of this test passed against the bug.
  const first = serverOwnedRuntime();

  let releaseOrdinary!: () => void;
  const ordinaryGate = new Promise<void>((resolve) => {
    releaseOrdinary = resolve;
  });
  first.onDispose(() => ordinaryGate);

  const ordinary = disposeServerOwnedRuntime();

  // Admitted before the latch, which is the only generation a drain has to
  // cover.
  const replacement = serverOwnedRuntime();
  expect(replacement).not.toBe(first);

  let releaseReplacement!: () => void;
  const replacementGate = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });
  let replacementDisposed = false;
  replacement.onDispose(async () => {
    await replacementGate;
    replacementDisposed = true;
  });

  const firstCaller = disposeServerOwnedRuntime({ drain: true });
  const secondCaller = disposeServerOwnedRuntime({ drain: true });

  let firstSettled = false;
  let secondSettled = false;
  void firstCaller.then(() => {
    firstSettled = true;
    return undefined;
  });
  void secondCaller.then(() => {
    secondSettled = true;
    return undefined;
  });

  releaseOrdinary();
  await ordinary;
  // A macrotask, so every continuation waiting on the ordinary disposal has
  // certainly run — a microtask tick would not prove the second caller had
  // reached its decision.
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The drain is parked on the replacement's teardown. NEITHER caller may
  // have resolved: the second one returning here is the defect.
  expect(replacementDisposed).toBe(false);
  expect(firstSettled).toBe(false);
  expect(secondSettled).toBe(false);

  releaseReplacement();
  await firstCaller;
  await secondCaller;

  expect(replacementDisposed).toBe(true);
  expect(firstSettled).toBe(true);
  expect(secondSettled).toBe(true);

  // And the latch still holds, so nothing refilled the slot on the way out.
  expect(() => serverOwnedRuntime()).toThrow(RuntimeTerminatingError);
});
