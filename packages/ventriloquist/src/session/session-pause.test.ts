import { describe, expect, test } from 'bun:test';

import {
  createScriptedIterable,
  createScriptedStream,
  createScriptedSubscription,
} from './fixtures/scripted-sources.ts';
import type { SessionEvent } from './session-types.ts';
import { createHarness, flush, startAndAttach } from './session.test-support.ts';

/** A byte pattern that makes a lost, duplicated or reordered byte visible. */
function pattern(length: number, offset = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index + offset) % 251);
}

function concatenate(events: readonly SessionEvent[]): Uint8Array {
  const parts = events.flatMap((event) => (event.type === 'output' ? [event.bytes] : []));
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

const BUDGET = 65_536;

/** Let the pumps run until they are waiting again: delivery goes on over several turns of the event loop. */
async function settle(): Promise<void> {
  // load-proof: the code under test yields with setImmediate after a fixed number of bytes, so the pumps need a number of event-loop iterations fixed by the byte counts, never by the load; thirty is more than any scenario here needs
  for (let turn = 0; turn < 30; turn += 1) await flush();
}

describe('a source the session can pause', () => {
  test('is not read once the output budget is nearly full, and nothing overflows', async () => {
    const stream = createScriptedStream('pty');
    const harness = createHarness({
      sources: [stream.source],
      budgets: { outputQueueBytes: BUDGET },
    });
    await startAndAttach(harness);
    for (let index = 0; index < 5; index += 1) stream.push(pattern(40_000, index));
    await flush();
    // Two reads: 40,000 fills most of the budget, the second chunk is cut to the room that is left.
    expect(stream.readCount).toBe(2);
    expect(harness.recorder.ofType('output').map((event) => event.bytes.length)).toEqual([
      40_000, 25_536,
    ]);
    expect(harness.recorder.ofType('attachmentRevoked')).toEqual([]);
    await flush();
    expect(stream.readCount).toBe(2);
    expect(harness.session.snapshot.closed).toBe(false);
  });

  test('resumes when the consumer reports parse completion, and delivers every byte once, in order', async () => {
    const stream = createScriptedStream('pty');
    const harness = createHarness({
      sources: [stream.source],
      budgets: { outputQueueBytes: BUDGET },
    });
    const attachment = await startAndAttach(harness);
    const sent: Uint8Array[] = [];
    for (let index = 0; index < 6; index += 1) {
      const chunk = pattern(40_000, index * 7);
      sent.push(chunk);
      stream.push(chunk);
    }
    const expected = new Uint8Array(240_000);
    sent.forEach((chunk, index) => expected.set(chunk, index * 40_000));
    await flush();
    let acknowledged = 0;
    for (
      let round = 0;
      round < 40 && concatenate(harness.recorder.events).length < 240_000;
      round += 1
    ) {
      const delivered = concatenate(harness.recorder.events).length;
      acknowledged = delivered;
      attachment.outputParsedThrough(acknowledged);
      await flush();
    }
    expect(concatenate(harness.recorder.events)).toEqual(expected);
    expect(harness.recorder.ofType('attachmentRevoked')).toEqual([]);
  });

  test('slices one chunk larger than the whole budget and carries the remainder exactly', async () => {
    const stream = createScriptedStream('pty');
    const harness = createHarness({
      sources: [stream.source],
      budgets: { outputQueueBytes: BUDGET },
    });
    const attachment = await startAndAttach(harness);
    const big = pattern(200_000);
    stream.push(big);
    await flush();
    expect(harness.recorder.ofType('output').map((event) => event.bytes.length)).toEqual([BUDGET]);
    for (let round = 0; round < 10; round += 1) {
      attachment.outputParsedThrough(concatenate(harness.recorder.events).length);
      await flush();
    }
    expect(concatenate(harness.recorder.events)).toEqual(big);
    // One read served the whole chunk; the next read is the one a paused session has not made yet.
    expect(stream.readCount).toBe(2);
  });

  test('waits for headroom before the first read when the budget is already full', async () => {
    const stream = createScriptedStream('pty');
    const harness = createHarness({
      sources: [stream.source],
      budgets: { outputQueueBytes: BUDGET },
    });
    const attachment = await startAndAttach(harness);
    stream.push(pattern(BUDGET));
    await flush();
    const readsWhenFull = stream.readCount;
    stream.push(pattern(10, 1));
    await flush();
    expect(stream.readCount).toBe(readsWhenFull);
    attachment.outputParsedThrough(BUDGET);
    await flush();
    // The released room admits the held chunk, and the pump is then already waiting on the next read.
    expect(stream.readCount).toBe(readsWhenFull + 2);
    expect(harness.recorder.ofType('output').at(-1)?.bytes).toEqual(pattern(10, 1));
  });

  test('applies to an async iterable exactly as to a stream', async () => {
    const iterable = createScriptedIterable('pty');
    const harness = createHarness({
      sources: [iterable.source],
      budgets: { outputQueueBytes: BUDGET },
    });
    const attachment = await startAndAttach(harness);
    const big = pattern(150_000);
    iterable.push(big);
    await flush();
    expect(harness.recorder.ofType('output').map((event) => event.bytes.length)).toEqual([BUDGET]);
    for (let round = 0; round < 10; round += 1) {
      attachment.outputParsedThrough(concatenate(harness.recorder.events).length);
      await flush();
    }
    expect(concatenate(harness.recorder.events)).toEqual(big);
  });

  test('the end of a paused source is reported only after its carried bytes are delivered', async () => {
    const stream = createScriptedStream('pty');
    const harness = createHarness({
      sources: [stream.source],
      budgets: { outputQueueBytes: BUDGET },
    });
    const attachment = await startAndAttach(harness);
    stream.push(pattern(100_000));
    stream.end();
    await flush();
    expect(harness.recorder.ofType('sourceComplete')).toEqual([]);
    for (let round = 0; round < 10; round += 1) {
      attachment.outputParsedThrough(concatenate(harness.recorder.events).length);
      await flush();
    }
    expect(concatenate(harness.recorder.events).length).toBe(100_000);
    expect(harness.recorder.ofType('sourceComplete')).toHaveLength(1);
  });

  test('a source that ends while the budget is full does not hang the session', async () => {
    const stream = createScriptedStream('pty');
    const harness = createHarness({
      sources: [stream.source],
      budgets: { outputQueueBytes: BUDGET },
    });
    const attachment = await startAndAttach(harness);
    stream.push(pattern(BUDGET));
    await flush();
    stream.end();
    await flush();
    attachment.outputParsedThrough(BUDGET);
    await flush();
    expect(harness.recorder.ofType('sourceComplete')).toHaveLength(1);
  });
});

describe('a burst the budget lets through', () => {
  test('lets the event loop run before it has all been delivered', async () => {
    const stream = createScriptedStream('pty');
    const harness = createHarness({ sources: [stream.source] });
    await startAndAttach(harness);
    const total = 16 * 65_536;
    let deliveredWhenTheLoopRan = -1;
    // Scheduled before the burst, so it runs first among the loop's turns after it.
    setImmediate(() => {
      deliveredWhenTheLoopRan = concatenate(harness.recorder.events).length;
    });
    for (let index = 0; index < 16; index += 1) stream.push(pattern(65_536, index));
    // It goes on in the turns that follow.
    for (
      let turn = 0;
      turn < 50 && concatenate(harness.recorder.events).length < total;
      turn += 1
    ) {
      await flush();
    }
    // A burst delivered without ever yielding would have finished before any other work could run,
    // which is what delays every other session and every client sharing the loop.
    expect(deliveredWhenTheLoopRan).toBeGreaterThanOrEqual(0);
    expect(deliveredWhenTheLoopRan).toBeLessThan(total / 2);
    expect(concatenate(harness.recorder.events).length).toBe(total);
  });
});

describe('two channels of one process', () => {
  test('share the one output budget: together they never hold more than it, and neither starves', async () => {
    const out = createScriptedStream('stdout');
    const err = createScriptedStream('stderr');
    const harness = createHarness({
      backend: { mode: 'pipe' },
      sources: [out.source, err.source],
      budgets: { outputQueueBytes: BUDGET },
    });
    const attachment = await startAndAttach(harness);
    out.push(pattern(30_000, 1));
    err.push(pattern(30_000, 2));
    out.push(pattern(30_000, 3));
    err.push(pattern(30_000, 4));
    await flush();
    const held = (channel: string): number =>
      harness.recorder
        .ofType('output')
        .filter((event) => event.channel === channel)
        .reduce((total, event) => total + event.bytes.length, 0);
    expect(held('stdout') + held('stderr')).toBeLessThanOrEqual(BUDGET);
    expect(held('stdout')).toBeGreaterThan(0);
    expect(held('stderr')).toBeGreaterThan(0);
    expect(harness.recorder.ofType('attachmentRevoked')).toEqual([]);
    for (let round = 0; round < 20; round += 1) {
      attachment.outputParsedThrough(
        harness.recorder.ofType('output').reduce((total, event) => total + event.bytes.length, 0),
      );
      await flush();
    }
    expect(held('stdout')).toBe(60_000);
    expect(held('stderr')).toBe(60_000);
  });
});

describe('two sources that read at the same moment', () => {
  test('never take more than the room there is, and both go on as it is freed', async () => {
    const out = createScriptedStream('stdout');
    const err = createScriptedStream('stderr');
    const limit = 262_144;
    const harness = createHarness({
      backend: { mode: 'pipe' },
      sources: [out.source, err.source],
      budgets: { outputQueueBytes: limit },
    });
    const attachment = await startAndAttach(harness);
    // Leave 70,000 bytes of room: enough that both sources are reading again, not enough for both of what they read.
    const filler = pattern(limit - 70_000, 3);
    out.push(filler);
    await settle();
    const first = pattern(65_536, 5);
    const second = pattern(65_536, 9);
    out.push(first);
    err.push(second);
    await settle();
    expect(harness.recorder.ofType('attachmentRevoked')).toEqual([]);
    expect(harness.session.snapshot.closed).toBe(false);
    const delivered = (channel: string): Uint8Array =>
      concatenate(
        harness.recorder.events.filter(
          (event) => event.type === 'output' && event.channel === channel,
        ),
      );
    // One of them took what it could and the other waited, so neither pushed the queue past its limit.
    expect(concatenate(harness.recorder.events).length).toBeLessThanOrEqual(limit);
    for (let round = 0; round < 60; round += 1) {
      attachment.outputParsedThrough(concatenate(harness.recorder.events).length);
      await settle();
    }
    expect(harness.recorder.ofType('attachmentRevoked')).toEqual([]);
    expect(delivered('stdout')).toEqual(new Uint8Array([...filler, ...first]));
    expect(delivered('stderr')).toEqual(second);
  });
});

describe('a paused session still answers control', () => {
  async function pausedSession() {
    const stream = createScriptedStream('pty');
    const harness = createHarness({
      sources: [stream.source],
      budgets: { outputQueueBytes: BUDGET },
    });
    const attachment = await startAndAttach(harness);
    stream.push(pattern(BUDGET));
    stream.push(pattern(100, 3));
    await flush();
    return { stream, harness, attachment };
  }

  test('input and resize reach the backend while output is held back', async () => {
    const { harness, attachment } = await pausedSession();
    attachment.write(new Uint8Array([97]));
    attachment.resize(100, 40);
    await flush();
    expect(harness.backend?.calls.slice(1)).toEqual([
      { call: 'write', bytes: new Uint8Array([97]) },
      { call: 'resize', columns: 100, rows: 40 },
    ]);
  });

  test('stop closes the session and cancels the paused reader', async () => {
    const { stream, harness, attachment } = await pausedSession();
    const stopped = attachment.stop();
    expect(stopped.accepted).toBe(true);
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('attachment-stop');
    expect(summary.cleanup).toBe('complete');
    expect(stream.cancelCount).toBe(1);
    expect(stream.lockReleased).toBe(true);
  });

  test('revoking authorization and disposal both end a paused session', async () => {
    const revoked = await pausedSession();
    const awaited13 = await revoked.harness.session.revokeAuthorization();
    expect(awaited13.cause).toBe('authorization-revoked');
    expect(revoked.stream.cancelCount).toBe(1);
    const disposed = await pausedSession();
    const awaited14 = await disposed.harness.session.dispose();
    expect(awaited14.cleanup).toBe('complete');
    expect(disposed.stream.cancelCount).toBe(1);
  });

  test('a carried chunk whose room opened in the same turn the session was revoked is counted, not delivered', async () => {
    const stream = createScriptedStream('pty');
    const harness = createHarness({
      sources: [stream.source],
      budgets: { outputQueueBytes: BUDGET },
    });
    const attachment = await startAndAttach(harness);
    stream.push(pattern(40_000));
    stream.push(pattern(40_000, 1));
    await settle();
    // The second chunk was cut to the room left, and its remainder waits in the pump for room.
    const delivered = harness.recorder.ofType('output').length;
    expect(delivered).toBe(2);
    // Room opens and the session is revoked before the pump's pending room promise continues, so its offer meets a revoked session.
    attachment.outputParsedThrough(BUDGET);
    const summary = await harness.session.revokeAuthorization();
    expect(summary.cause).toBe('authorization-revoked');
    expect(stream.cancelCount).toBe(1);
    expect(harness.recorder.ofType('output')).toHaveLength(delivered);
  });

  test('a natural exit while paused waits for the consumer, then drains everything', async () => {
    const { stream, harness, attachment } = await pausedSession();
    harness.session.reportProcessExit(0, null);
    stream.end();
    await flush();
    expect(harness.session.snapshot.closed).toBe(false);
    for (let round = 0; round < 10 && !harness.session.snapshot.closed; round += 1) {
      attachment.outputParsedThrough(concatenate(harness.recorder.events).length);
      await flush();
    }
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('process-exit');
    expect(summary.drain).toEqual({ state: 'drained', unavailableBytes: 0 });
    expect(concatenate(harness.recorder.events).length).toBe(BUDGET + 100);
  });
});

describe('a source that cannot be paused', () => {
  test('a pushed subscription still fails the session with output-overflow', async () => {
    const subscription = createScriptedSubscription('pty');
    const harness = createHarness({
      sources: [subscription.source],
      budgets: { outputQueueBytes: BUDGET },
    });
    await startAndAttach(harness);
    subscription.push(new Uint8Array(40_000));
    subscription.push(new Uint8Array(40_000));
    await flush();
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('output-overflow');
    expect(summary.quarantined).toBe(true);
    expect(harness.recorder.ofType('output')).toHaveLength(1);
  });
});
