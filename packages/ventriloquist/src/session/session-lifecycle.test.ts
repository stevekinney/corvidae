import { describe, expect, test } from 'bun:test';

import { createDeferred } from './fixtures/deferred.ts';
import { createScriptedSubscription } from './fixtures/scripted-sources.ts';
import type { CloseCause } from './session-types.ts';
import {
  createHarness,
  expectNoOutputAfterClosed,
  flush,
  startAndAttach,
  utf8,
} from './session.test-support.ts';

describe('process exit', () => {
  test('is emitted once, disables input, and may precede trailing output', async () => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness);
    harness.stream.push(utf8('first'));
    await flush();
    expect(harness.session.reportProcessExit(3, null)).toBe(true);
    expect(harness.session.reportProcessExit(4, 'SIGKILL')).toBe(false);
    expect(harness.session.snapshot.process).toEqual({ kind: 'exited', exitCode: 3, signal: null });
    expect(attachment.write(utf8('late'))).toMatchObject({
      disposition: 'failed',
      reason: 'input-disabled',
    });

    // The exit came first; the output that followed it is still delivered before the session closes.
    harness.stream.push(utf8('trailing'));
    await flush();
    expect(harness.recorder.ofType('output').map((event) => event.bytes.length)).toEqual([5, 8]);
    expect(harness.session.snapshot.closed).toBe(false);

    attachment.outputParsedThrough(13);
    harness.stream.end();
    await flush();
    expect(harness.recorder.types).toEqual([
      'output',
      'processExit',
      'output',
      'sourceComplete',
      'attachmentRevoked',
      'sessionClosed',
    ]);
    expect(harness.recorder.ofType('processExit')).toEqual([
      { type: 'processExit', exitCode: 3, signal: null },
    ]);
    expectNoOutputAfterClosed(harness.recorder.events);
    expect(await harness.session.closed).toMatchObject({
      cause: 'process-exit',
      cleanup: 'complete',
      drain: { state: 'drained', unavailableBytes: 0 },
      process: { kind: 'exited', exitCode: 3, signal: null },
      quarantined: false,
    });
  });

  test('records a signal distinctly from a zero exit code', async () => {
    const harness = createHarness();
    await startAndAttach(harness);
    harness.session.reportProcessExit(null, 'SIGTERM');
    harness.stream.end();
    await flush();
    expect(harness.session.snapshot.process).toEqual({
      kind: 'exited',
      exitCode: null,
      signal: 'SIGTERM',
    });
  });

  test('cancels operations still queued, explicitly', async () => {
    const barrier = createDeferred<void>();
    const harness = createHarness({ backend: { write: () => barrier.promise } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('a'));
    await flush();
    attachment.write(utf8('b'));
    attachment.resize(100, 40);
    harness.session.reportProcessExit(0, null);
    expect(harness.recorder.ofType('operationResult')).toEqual([
      {
        type: 'operationResult',
        sequence: 2,
        kind: 'input',
        disposition: 'canceled',
        reason: 'process-exited',
      },
      {
        type: 'operationResult',
        sequence: 3,
        kind: 'resize',
        disposition: 'canceled',
        reason: 'process-exited',
      },
    ]);
    barrier.resolve();
    harness.stream.end();
    await flush();
  });

  test('is still recorded when a close is already under way, and does not change its cause', async () => {
    const cleanupBarrier = createDeferred<'complete'>();
    const harness = createHarness({ backend: { cleanup: () => cleanupBarrier.promise } });
    await startAndAttach(harness);
    const closing = harness.session.stop();
    await flush();
    expect(harness.session.snapshot.cleanup).toEqual({ kind: 'running' });
    expect(harness.session.reportProcessExit(137, 'SIGKILL')).toBe(true);
    cleanupBarrier.resolve('complete');
    expect(await closing).toMatchObject({
      cause: 'host-stop',
      process: { kind: 'exited', exitCode: 137, signal: 'SIGKILL' },
    });
    expectNoOutputAfterClosed(harness.recorder.events);
  });

  test('is ignored once the session has closed', async () => {
    const harness = createHarness();
    await startAndAttach(harness);
    await harness.session.dispose();
    expect(harness.session.reportProcessExit(0, null)).toBe(false);
    expect(harness.recorder.ofType('processExit')).toEqual([]);
  });
});

describe('end of file is not process exit', () => {
  test('source completion leaves the process running and the session open', async () => {
    const harness = createHarness();
    await startAndAttach(harness);
    harness.stream.end();
    await flush();
    expect(harness.recorder.ofType('sourceComplete')).toEqual([
      { type: 'sourceComplete', channel: 'pty' },
    ]);
    expect(harness.session.snapshot.process).toEqual({ kind: 'running' });
    expect(harness.session.snapshot.closed).toBe(false);
    expect(harness.session.snapshot.cleanup).toEqual({ kind: 'idle' });
  });

  test('an output-only session closes on completion without inventing an exit', async () => {
    const subscription = createScriptedSubscription();
    const harness = createHarness({ backend: false, sources: [subscription.source] });
    const attachment = await startAndAttach(harness, 'read-only');
    subscription.push(utf8('done'));
    await flush();
    subscription.end();
    await flush();
    // The consumer has not reported the chunk parsed, so the session waits to drain it.
    expect(harness.session.snapshot.closed).toBe(false);
    attachment.outputParsed(1);
    await flush();
    expect(await harness.session.closed).toMatchObject({
      cause: 'source-complete',
      process: { kind: 'running' },
      cleanup: 'complete',
      drain: { state: 'drained', unavailableBytes: 0 },
    });
    expect(subscription.unsubscribeCount).toBe(1);
  });
});

describe('the final sessionClosed', () => {
  test('waits for the drain deadline, then reports undelivered output as unavailable', async () => {
    const harness = createHarness();
    await startAndAttach(harness);
    harness.stream.push(utf8('unparsed'));
    await flush();
    harness.session.reportProcessExit(0, null);
    harness.stream.end();
    await flush();
    expect(harness.session.snapshot.closed).toBe(false);
    harness.clock.advance(4_999);
    await flush();
    expect(harness.session.snapshot.closed).toBe(false);
    harness.clock.advance(1);
    await flush();
    expect(await harness.session.closed).toMatchObject({
      cause: 'process-exit',
      cleanup: 'complete',
      drain: { state: 'truncated', unavailableBytes: 8 },
    });
    expectNoOutputAfterClosed(harness.recorder.events);
    expect(harness.clock.pendingTimers).toBe(0);
  });

  test('a forced close does not wait for output to drain', async () => {
    const harness = createHarness();
    await startAndAttach(harness);
    harness.stream.push(utf8('unparsed'));
    await flush();
    await harness.session.dispose();
    const summary = await harness.session.closed;
    expect(summary.drain).toEqual({ state: 'truncated', unavailableBytes: 8 });
  });

  test('output that arrives after revocation is counted unavailable, never delivered', async () => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness);
    const closing = attachment.detach();
    harness.stream.push(utf8('after'));
    await closing;
    expect(harness.recorder.ofType('output')).toEqual([]);
    const summary = await harness.session.closed;
    expect(summary.drain).toEqual({ state: 'truncated', unavailableBytes: 5 });
  });

  test('no output is delivered after it, even if a source keeps producing', async () => {
    const subscription = createScriptedSubscription();
    const harness = createHarness({ sources: [subscription.source] });
    await startAndAttach(harness);
    await harness.session.dispose();
    subscription.push(utf8('ignored'));
    await flush();
    expectNoOutputAfterClosed(harness.recorder.events);
  });
});

describe('startup', () => {
  test('a rejected launch is a failed process, not a successful exit', async () => {
    const harness = createHarness({
      backend: { start: () => Promise.reject(new Error('no shell')) },
    });
    await startAndAttach(harness);
    expect(harness.session.snapshot.process).toEqual({ kind: 'failed', reason: 'start-rejected' });
    expect(await harness.session.closed).toMatchObject({
      cause: 'start-failed',
      cleanup: 'complete',
      process: { kind: 'failed', reason: 'start-rejected' },
    });
    expect(harness.backend?.calls).toEqual([{ call: 'start' }, { call: 'cleanup' }]);
  });

  test('a launch that throws synchronously is the same failure', async () => {
    const harness = createHarness({
      backend: {
        start: () => {
          throw new Error('synchronous');
        },
      },
    });
    await startAndAttach(harness);
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('start-failed');
  });

  test('disposal during startup cleans up only after the launch settles, and never runs the process', async () => {
    const launch = createDeferred<void>();
    const harness = createHarness({ backend: { start: () => launch.promise } });
    await startAndAttach(harness);
    expect(harness.session.snapshot.process).toEqual({ kind: 'starting' });
    const closing = harness.session.dispose();
    await flush();
    // The launch is still in flight, so the process cannot be cleaned up yet.
    expect(harness.backend?.calls).toEqual([{ call: 'start' }]);
    expect(harness.session.snapshot.cleanup).toEqual({ kind: 'running' });
    launch.resolve();
    expect(await closing).toMatchObject({
      cause: 'host-dispose',
      cleanup: 'complete',
      process: { kind: 'failed', reason: 'closed-during-startup' },
    });
    expect(harness.backend?.calls).toEqual([{ call: 'start' }, { call: 'cleanup' }]);
    // The late launch result must not resurrect the process or start reading.
    expect(harness.session.snapshot.process).toEqual({
      kind: 'failed',
      reason: 'closed-during-startup',
    });
    expect(harness.recorder.ofType('output')).toEqual([]);
  });

  test('a launch that never settles leaves the cleanup unknown at the deadline', async () => {
    const harness = createHarness({ backend: { start: () => new Promise(() => undefined) } });
    await startAndAttach(harness);
    const closing = harness.session.dispose();
    await flush();
    harness.clock.advance(5_000);
    expect(await closing).toMatchObject({ cleanup: 'unknown', quarantined: true });
    expect(harness.backend?.calls).toEqual([{ call: 'start' }]);
  });

  test('disposal before start launches nothing', async () => {
    const harness = createHarness();
    await harness.session.dispose();
    await harness.session.start();
    expect(harness.backend?.calls).toEqual([{ call: 'cleanup' }]);
    expect(harness.session.snapshot.process).toEqual({
      kind: 'failed',
      reason: 'closed-during-startup',
    });
  });

  test('a launch that settles after a different close does not change the outcome', async () => {
    const launch = createDeferred<void>();
    const harness = createHarness({ backend: { start: () => launch.promise } });
    const attachment = await startAndAttach(harness);
    const closing = attachment.detach();
    launch.reject(new Error('late'));
    await closing;
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('disconnect');
  });
});

describe('attach versus exit', () => {
  test('an exit before any attachment closes the session, so a later attach is refused', async () => {
    const harness = createHarness();
    await harness.session.start();
    harness.session.reportProcessExit(0, null);
    await flush();
    expect(await harness.session.closed).toMatchObject({
      cause: 'process-exit',
      drain: { state: 'drained', unavailableBytes: 0 },
    });
    expect(
      harness.session.attach({
        requestedMode: 'interactive',
        grant: 'interactive',
        listener: harness.recorder.listener,
      }),
    ).toEqual({ accepted: false, reason: 'session-closed' });
  });

  test('an attachment taken before the exit sees the exit', async () => {
    const harness = createHarness();
    await startAndAttach(harness);
    harness.session.reportProcessExit(0, null);
    expect(harness.recorder.ofType('processExit')).toHaveLength(1);
    harness.stream.end();
    await flush();
  });

  test('an exit during startup is recorded, and the sources still start and drain', async () => {
    const launch = createDeferred<void>();
    const harness = createHarness({ backend: { start: () => launch.promise } });
    const attachment = await startAndAttach(harness);
    harness.session.reportProcessExit(1, null);
    launch.resolve();
    await flush();
    harness.stream.push(utf8('tail'));
    harness.stream.end();
    await flush();
    expect(harness.recorder.ofType('output')).toHaveLength(1);
    attachment.outputParsedThrough(4);
    expect(await harness.session.closed).toMatchObject({
      cause: 'process-exit',
      process: { kind: 'exited', exitCode: 1, signal: null },
    });
  });
});

type Trigger = {
  readonly name: string;
  readonly cause: CloseCause;
  run(
    harness: ReturnType<typeof createHarness>,
    attachment: Awaited<ReturnType<typeof startAndAttach>>,
  ): void;
};

const TRIGGERS: readonly Trigger[] = [
  { name: 'attachment stop', cause: 'attachment-stop', run: (_h, a) => void a.stop() },
  { name: 'host stop', cause: 'host-stop', run: (h) => void h.session.stop() },
  { name: 'host dispose', cause: 'host-dispose', run: (h) => void h.session.dispose() },
  { name: 'disconnect', cause: 'disconnect', run: (_h, a) => void a.detach() },
  {
    name: 'authorization revoked',
    cause: 'authorization-revoked',
    run: (h) => void h.session.revokeAuthorization(),
  },
  { name: 'liveness expiry', cause: 'liveness-expired', run: (h) => h.clock.advance(30_000) },
  {
    name: 'process exit',
    cause: 'process-exit',
    run: (h) => void h.session.reportProcessExit(0, null),
  },
];

describe('every double-close ordering', () => {
  const pairs = TRIGGERS.flatMap((first) => TRIGGERS.map((second) => [first, second] as const));

  test.each(pairs)('%o then %o in the same turn', async (first, second) => {
    await expectSingleClose(first, second, false);
  });

  test.each(pairs)('%o then %o across turns', async (first, second) => {
    await expectSingleClose(first, second, true);
  });

  async function expectSingleClose(first: Trigger, second: Trigger, turnBetween: boolean) {
    const harness = createHarness();
    const attachment = await startAndAttach(harness);
    first.run(harness, attachment);
    if (turnBetween) await flush();
    second.run(harness, attachment);
    harness.stream.end();
    await flush();
    const summary = await harness.session.closed;
    expect(summary.cause).toBe(first.cause);
    expect(summary.cleanup).toBe('complete');
    expect(harness.backend?.calls.filter((call) => call.call === 'cleanup')).toHaveLength(1);
    expect(harness.recorder.ofType('attachmentRevoked')).toHaveLength(1);
    expect(harness.recorder.ofType('processExit').length).toBeLessThanOrEqual(1);
    expectNoOutputAfterClosed(harness.recorder.events);
    // Whichever way the session was asked to close again, the answer is the one result.
    expect(await harness.session.stop()).toBe(summary);
    expect(await harness.session.dispose()).toBe(summary);
    expect(harness.clock.pendingTimers).toBe(0);
  }
});

describe('repeated stop and dispose', () => {
  test('return the same promise and the same result, however they interleave', async () => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness);
    const stop = harness.session.stop();
    expect(harness.session.stop()).toBe(stop);
    expect(harness.session.dispose()).toBe(stop);
    const receipt = attachment.stop();
    expect(receipt.accepted && receipt.closed).toBe(stop);
    expect(attachment.detach()).toBe(stop);
    const summary = await stop;
    expect(await attachment.detach()).toBe(summary);
    expect(harness.backend?.calls.filter((call) => call.call === 'cleanup')).toHaveLength(1);
  });

  test('a session with no attachment closes cleanly and says so', async () => {
    const harness = createHarness();
    await harness.session.start();
    const summary = await harness.session.stop();
    expect(summary).toMatchObject({ cause: 'host-stop', cleanup: 'complete', quarantined: false });
    expect(harness.session.snapshot).toMatchObject({
      closed: true,
      cleanup: { kind: 'finished', outcome: 'complete' },
      connection: { kind: 'detached' },
    });
  });
});
