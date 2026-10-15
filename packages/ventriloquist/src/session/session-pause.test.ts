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
    expect((await revoked.harness.session.revokeAuthorization()).cause).toBe(
      'authorization-revoked',
    );
    expect(revoked.stream.cancelCount).toBe(1);
    const disposed = await pausedSession();
    expect((await disposed.harness.session.dispose()).cleanup).toBe('complete');
    expect(disposed.stream.cancelCount).toBe(1);
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
