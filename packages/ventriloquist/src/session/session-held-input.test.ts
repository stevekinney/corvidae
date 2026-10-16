import { describe, expect, test } from 'bun:test';

import { createDeferred } from './fixtures/deferred.ts';
import type { InputHold } from './session-types.ts';
import { createHarness, flush, startAndAttach, utf8 } from './session.test-support.ts';

/** A backend whose write is queued behind a child that is not reading, until the test lets it drain. */
function heldBackend() {
  const drained = createDeferred<void>();
  const holds: InputHold[] = [];
  return {
    drained,
    holds,
    write: (_bytes: Uint8Array, hold: InputHold | undefined) => {
      if (hold !== undefined) holds.push(hold);
      hold?.held();
      return drained.promise;
    },
  };
}

describe('input held by a child that is not reading', () => {
  test('does not expire the acknowledgement deadline or fail the session', async () => {
    const held = heldBackend();
    const harness = createHarness({ backend: { write: held.write } });
    const attachment = await startAndAttach(harness);
    expect(attachment.inputHeld).toBe(false);
    attachment.write(utf8('paste'));
    await flush();
    expect(attachment.inputHeld).toBe(true);
    // Far past the 2 s deadline, with the peer still alive.
    for (let elapsed = 0; elapsed < 60_000; elapsed += 10_000) {
      harness.clock.advance(10_000);
      attachment.heartbeat();
    }
    await flush();
    expect(harness.recorder.ofType('operationResult')).toEqual([]);
    expect(harness.session.snapshot.closed).toBe(false);
    expect(harness.session.snapshot.process.kind).toBe('running');
  });

  test('refuses new input, resize and an empty probe as held, without queueing or replaying them', async () => {
    const held = heldBackend();
    const harness = createHarness({ backend: { write: held.write } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('paste'));
    await flush();
    for (const receipt of [
      attachment.write(utf8('x')),
      attachment.write(new Uint8Array(0)),
      attachment.reply(utf8('r')),
      attachment.resize(100, 40),
    ]) {
      expect(receipt).toMatchObject({ disposition: 'failed', reason: 'input-held' });
    }
    held.drained.resolve();
    await flush();
    const writes = harness.backend?.calls.filter((call) => call.call === 'write');
    expect(writes).toHaveLength(1);
    expect(harness.backend?.calls.some((call) => call.call === 'resize')).toBe(false);
  });

  test('delivers every accepted byte once and in order when the child reads, then accepts input again', async () => {
    const held = heldBackend();
    const harness = createHarness({ backend: { write: held.write } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('one'));
    // Accepted before the backend reported the hold: queued behind the held write.
    attachment.write(utf8('two'));
    await flush();
    expect(attachment.inputHeld).toBe(true);
    held.drained.resolve();
    await flush();
    expect(attachment.inputHeld).toBe(false);
    expect(
      harness.backend?.calls.filter((call) => call.call === 'write').map((call) => call.bytes),
    ).toEqual([utf8('one'), utf8('two')]);
    expect(attachment.write(utf8('three'))).toMatchObject({ disposition: 'accepted' });
    expect(harness.recorder.ofType('operationResult')).toEqual([]);
  });

  test('keeps held bytes within the input budget', async () => {
    const held = heldBackend();
    const harness = createHarness({
      backend: { write: held.write },
      budgets: { inputQueueBytes: 1_024 },
    });
    const attachment = await startAndAttach(harness);
    expect(attachment.write(new Uint8Array(1_000))).toMatchObject({ disposition: 'accepted' });
    await flush();
    // Held already, so this is refused as held; once released the budget refuses what does not fit.
    expect(attachment.write(new Uint8Array(100))).toMatchObject({ reason: 'input-held' });
  });

  test('starts the deadline over when the write stops waiting on the child but is not done', async () => {
    const barrier = createDeferred<void>();
    let hold: InputHold | undefined;
    const harness = createHarness({
      backend: {
        write: (_bytes, given) => {
          hold = given;
          given?.held();
          return barrier.promise;
        },
      },
    });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('x'));
    await flush();
    harness.clock.advance(10_000);
    attachment.heartbeat();
    hold?.resumed();
    expect(attachment.inputHeld).toBe(false);
    harness.clock.advance(1_999);
    await flush();
    expect(harness.recorder.ofType('operationResult')).toEqual([]);
    harness.clock.advance(1);
    await flush();
    expect(harness.recorder.ofType('operationResult')).toMatchObject([
      { disposition: 'unknown', reason: 'acknowledgement-deadline' },
    ]);
  });

  test('ignores a hold report from a write that already settled', async () => {
    const held = heldBackend();
    const harness = createHarness({ backend: { write: held.write } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('x'));
    await flush();
    held.drained.resolve();
    await flush();
    held.holds[0]?.held();
    held.holds[0]?.resumed();
    expect(attachment.inputHeld).toBe(false);
  });

  test('a write that is not held still expires as unknown delivery', async () => {
    const harness = createHarness({ backend: { write: () => new Promise(() => undefined) } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('lost'));
    await flush();
    expect(attachment.inputHeld).toBe(false);
    harness.clock.advance(2_000);
    await flush();
    expect(harness.recorder.ofType('operationResult')).toMatchObject([
      { disposition: 'unknown', reason: 'acknowledgement-deadline' },
    ]);
  });

  test('a backend write error while held is a backend failure', async () => {
    const held = heldBackend();
    const harness = createHarness({ backend: { write: held.write } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('x'));
    await flush();
    held.drained.reject(new Error('EPIPE'));
    await flush();
    expect(harness.recorder.ofType('operationResult')).toMatchObject([
      { disposition: 'failed', reason: 'backend-failed' },
    ]);
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('backend-failed');
  });

  test('stop while held cancels what is queued, reports the held write as unknown, and cleans up', async () => {
    const held = heldBackend();
    const harness = createHarness({ backend: { write: held.write } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('held'));
    attachment.write(utf8('queued'));
    await flush();
    const stopped = attachment.stop();
    expect(stopped.accepted).toBe(true);
    const summary = await harness.session.closed;
    expect(summary).toMatchObject({ cause: 'attachment-stop', cleanup: 'complete' });
    expect(harness.recorder.ofType('operationResult')).toMatchObject([
      { sequence: 2, disposition: 'canceled', reason: 'revoked' },
      { sequence: 1, disposition: 'unknown', reason: 'closed-before-acknowledgement' },
    ]);
    expect(harness.backend?.calls.at(-1)).toEqual({ call: 'cleanup' });
  });

  test('revoking authorization while held freezes input and reports the held write as unknown', async () => {
    const held = heldBackend();
    const harness = createHarness({ backend: { write: held.write } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('held'));
    await flush();
    void harness.session.revokeAuthorization();
    await harness.session.closed;
    expect(attachment.write(utf8('late'))).toMatchObject({ reason: 'stale-generation' });
    expect(harness.recorder.ofType('operationResult')).toMatchObject([
      { sequence: 1, disposition: 'unknown', reason: 'closed-before-acknowledgement' },
    ]);
  });

  test('a lost transport while held is unknown delivery too', async () => {
    const held = heldBackend();
    const harness = createHarness({ backend: { write: held.write } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('held'));
    await flush();
    const summary = await attachment.detach();
    expect(summary.cause).toBe('disconnect');
    expect(harness.recorder.ofType('operationResult')).toMatchObject([
      { disposition: 'unknown', reason: 'closed-before-acknowledgement' },
    ]);
  });
});
