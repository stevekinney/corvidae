import { describe, expect, test } from 'bun:test';

import { createDeferred } from './fixtures/deferred.ts';
import { createScriptedStream } from './fixtures/scripted-sources.ts';
import { SESSION_BUDGET_RANGES, resolveSessionBudgets } from './session-budgets.ts';
import { DEFAULT_SESSION_BUDGETS } from './session-types.ts';
import { createHarness, flush, startAndAttach, utf8 } from './session.test-support.ts';

describe('budgets', () => {
  test('default to the documented conservative values', () => {
    expect(resolveSessionBudgets()).toEqual({
      operationQueueLimit: 256,
      reservedControlCapacity: 8,
      inputQueueBytes: 65_536,
      outputQueueBytes: 1_048_576,
      inputAcknowledgementDeadlineMilliseconds: 2_000,
      livenessDeadlineMilliseconds: 30_000,
      cleanupDeadlineMilliseconds: 5_000,
    });
    expect(resolveSessionBudgets({})).toEqual(DEFAULT_SESSION_BUDGETS);
  });

  test.each(Object.entries(SESSION_BUDGET_RANGES))(
    'accept %s at both ends of its range and refuse a value beyond either',
    (name, range) => {
      expect(resolveSessionBudgets({ [name]: range.minimum })).toMatchObject({
        [name]: range.minimum,
      });
      expect(resolveSessionBudgets({ [name]: range.maximum })).toMatchObject({
        [name]: range.maximum,
      });
      expect(() => resolveSessionBudgets({ [name]: range.minimum - 1 })).toThrow(RangeError);
      expect(() => resolveSessionBudgets({ [name]: range.maximum + 1 })).toThrow(RangeError);
    },
  );

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 2.5, -1])(
    'refuse %j rather than coercing it',
    (value) => {
      expect(() => resolveSessionBudgets({ inputQueueBytes: value })).toThrow(RangeError);
    },
  );
});

describe('input and resize share one ordered FIFO', () => {
  test('reach the backend in the order they were accepted', async () => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness);
    expect(attachment.write(utf8('a'))).toEqual({ disposition: 'accepted', sequence: 1 });
    expect(attachment.resize(100, 40)).toEqual({ disposition: 'accepted', sequence: 2 });
    expect(attachment.write(utf8('b'), { sequence: 9 })).toEqual({
      disposition: 'accepted',
      sequence: 9,
    });
    await flush();
    expect(harness.backend?.calls.slice(1)).toEqual([
      { call: 'write', bytes: utf8('a') },
      { call: 'resize', columns: 100, rows: 40 },
      { call: 'write', bytes: utf8('b') },
    ]);
  });

  test('copy what they accept, so later mutation cannot change it', async () => {
    const barrier = createDeferred<void>();
    const harness = createHarness({ backend: { write: () => barrier.promise } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('hold'));
    const bytes = utf8('queued');
    attachment.write(bytes);
    bytes.fill(0);
    barrier.resolve();
    await flush();
    expect(harness.backend?.calls.at(-1)).toEqual({ call: 'write', bytes: utf8('queued') });
  });

  test.each([
    [0, 24],
    [80, 0],
    [65_536, 24],
    [80.5, 24],
  ])('a resize to %j by %j is refused before it is queued', async (columns, rows) => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness);
    expect(attachment.resize(columns, rows)).toMatchObject({
      disposition: 'failed',
      reason: 'invalid-dimensions',
    });
    await flush();
    expect(harness.backend?.calls.filter((call) => call.call === 'resize')).toEqual([]);
  });
});

describe('overflow', () => {
  test('input over the byte budget fails with input-overflow and queues nothing', async () => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness);
    expect(attachment.write(new Uint8Array(65_537))).toMatchObject({
      disposition: 'failed',
      reason: 'input-overflow',
    });
    expect(attachment.write(new Uint8Array(65_536))).toMatchObject({ disposition: 'accepted' });
    await flush();
    expect(harness.backend?.calls.filter((call) => call.call === 'write')).toHaveLength(1);
    expect(harness.session.snapshot.connection.kind).toBe('attached');
  });

  test('input bytes count until the backend settles them, then capacity returns', async () => {
    const barrier = createDeferred<void>();
    const harness = createHarness({ backend: { write: () => barrier.promise } });
    const attachment = await startAndAttach(harness);
    expect(attachment.write(new Uint8Array(60_000))).toMatchObject({ disposition: 'accepted' });
    expect(attachment.write(new Uint8Array(6_000))).toMatchObject({
      disposition: 'failed',
      reason: 'input-overflow',
    });
    barrier.resolve();
    await flush();
    expect(attachment.write(new Uint8Array(6_000))).toMatchObject({ disposition: 'accepted' });
  });

  test('the 258th single-byte operation hits fifo-full, and stop is still admitted', async () => {
    const barrier = createDeferred<void>();
    const harness = createHarness({ backend: { write: () => barrier.promise } });
    const attachment = await startAndAttach(harness);
    // One operation is in flight with the backend; the FIFO then holds 256 more.
    for (let index = 0; index < 257; index += 1) {
      expect(attachment.write(Uint8Array.of(1))).toMatchObject({ disposition: 'accepted' });
    }
    expect(attachment.write(Uint8Array.of(1))).toMatchObject({
      disposition: 'failed',
      reason: 'fifo-full',
    });
    const receipt = attachment.stop();
    expect(receipt.accepted).toBe(true);
    barrier.resolve();
    const summary = await harness.session.closed;
    expect(summary).toMatchObject({ cause: 'attachment-stop', cleanup: 'complete' });
    const canceled = harness.recorder
      .ofType('operationResult')
      .filter((event) => event.disposition === 'canceled');
    expect(canceled).toHaveLength(256);
  });

  test('output over the budget revokes the generation and quarantines the slot', async () => {
    const stream = createScriptedStream('pty');
    const harness = createHarness({
      sources: [stream.source],
      budgets: { outputQueueBytes: 65_536 },
    });
    await startAndAttach(harness);
    stream.push(new Uint8Array(65_537));
    await flush();
    expect(harness.recorder.ofType('output')).toEqual([]);
    expect(harness.recorder.ofType('attachmentRevoked')).toEqual([
      { type: 'attachmentRevoked', generation: 1, cause: 'output-overflow' },
    ]);
    expect(await harness.session.closed).toEqual({
      sessionIdentity: harness.session.sessionId,
      cause: 'output-overflow',
      process: { kind: 'running' },
      cleanup: 'incomplete',
      drain: { state: 'truncated', unavailableBytes: 65_537 },
      quarantined: true,
    });
    expect(harness.session.snapshot.quarantined).toBe(true);
  });

  test('accepted output is never dropped: the chunk that does not fit fails the session', async () => {
    const stream = createScriptedStream('pty');
    const harness = createHarness({
      sources: [stream.source],
      budgets: { outputQueueBytes: 65_536 },
    });
    await startAndAttach(harness);
    stream.push(new Uint8Array(40_000));
    stream.push(new Uint8Array(40_000));
    await flush();
    expect(harness.recorder.ofType('output')).toHaveLength(1);
    const summary = await harness.session.closed;
    expect(summary.drain).toEqual({ state: 'truncated', unavailableBytes: 80_000 });
  });
});

describe('output capacity is released only at a per-write parse completion', () => {
  async function fillTo(limit: number) {
    const stream = createScriptedStream('pty');
    const harness = createHarness({
      sources: [stream.source],
      budgets: { outputQueueBytes: limit },
    });
    const attachment = await startAndAttach(harness);
    return { stream, harness, attachment };
  }

  test('a chunk is released by its own identifier and by nothing else', async () => {
    const { stream, harness, attachment } = await fillTo(65_536);
    stream.push(new Uint8Array(40_000));
    await flush();
    const [first] = harness.recorder.ofType('output');
    expect(attachment.outputParsed(first!.chunkId + 100)).toBe(false);
    expect(attachment.outputParsedThrough(39_999)).toBe(0);
    // Neither an unknown chunk nor a count that only partly covers it freed any capacity.
    stream.push(new Uint8Array(40_000));
    await flush();
    expect(harness.session.snapshot.closed).toBe(true);
  });

  test('parsing a chunk returns exactly its capacity', async () => {
    const { stream, harness, attachment } = await fillTo(65_536);
    stream.push(new Uint8Array(40_000));
    await flush();
    const [first] = harness.recorder.ofType('output');
    expect(attachment.outputParsed(first!.chunkId)).toBe(true);
    expect(attachment.outputParsed(first!.chunkId)).toBe(false);
    stream.push(new Uint8Array(40_000));
    await flush();
    expect(harness.recorder.ofType('output')).toHaveLength(2);
    expect(harness.session.snapshot.closed).toBe(false);
  });

  test('a cumulative count releases every chunk it fully covers', async () => {
    const { stream, harness, attachment } = await fillTo(65_536);
    stream.push(new Uint8Array(10_000));
    stream.push(new Uint8Array(10_000));
    stream.push(new Uint8Array(10_000));
    await flush();
    expect(attachment.outputParsedThrough(25_000)).toBe(2);
    expect(harness.recorder.ofType('output')).toHaveLength(3);
  });
});

describe('backend failure and unknown delivery', () => {
  test('a rejected write is a failed operation that revokes the generation', async () => {
    let calls = 0;
    const harness = createHarness({
      backend: {
        write: () => {
          calls += 1;
          return Promise.reject(new Error('EPIPE'));
        },
      },
    });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('a'));
    attachment.write(utf8('b'));
    attachment.write(utf8('c'));
    await flush();
    expect(harness.recorder.ofType('operationResult')).toEqual([
      {
        type: 'operationResult',
        sequence: 1,
        kind: 'input',
        disposition: 'failed',
        reason: 'backend-failed',
      },
      {
        type: 'operationResult',
        sequence: 2,
        kind: 'input',
        disposition: 'canceled',
        reason: 'revoked',
      },
      {
        type: 'operationResult',
        sequence: 3,
        kind: 'input',
        disposition: 'canceled',
        reason: 'revoked',
      },
    ]);
    const summary = await harness.session.closed;
    expect(summary).toMatchObject({ cause: 'backend-failed', cleanup: 'complete' });
    // Nothing was retried or replayed.
    expect(calls).toBe(1);
  });

  test('a write the backend never settles is unknown delivery at the deadline, never success', async () => {
    const harness = createHarness({ backend: { write: () => new Promise(() => undefined) } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('hang'));
    await flush();
    harness.clock.advance(1_999);
    await flush();
    expect(harness.recorder.ofType('operationResult')).toEqual([]);
    harness.clock.advance(1);
    await flush();
    expect(harness.recorder.ofType('operationResult')).toEqual([
      {
        type: 'operationResult',
        sequence: 1,
        kind: 'input',
        disposition: 'unknown',
        reason: 'acknowledgement-deadline',
      },
    ]);
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('delivery-unknown');
    expect(harness.backend?.calls.filter((call) => call.call === 'write')).toHaveLength(1);
  });

  test('a write that settles after its deadline changes nothing', async () => {
    const barrier = createDeferred<void>();
    const harness = createHarness({ backend: { write: () => barrier.promise } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('slow'));
    await flush();
    harness.clock.advance(2_000);
    await flush();
    barrier.resolve();
    await flush();
    expect(harness.recorder.ofType('operationResult')).toHaveLength(1);
  });
});

describe('no replay and no respawn', () => {
  test('after a disconnect the process is not restarted and queued input is not replayed', async () => {
    const barrier = createDeferred<void>();
    const harness = createHarness({ backend: { write: () => barrier.promise } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('in flight'));
    attachment.write(utf8('queued'));
    await attachment.detach();
    barrier.resolve();
    await flush();
    await harness.session.start();
    expect(harness.backend?.calls.map((call) => call.call)).toEqual(['start', 'write', 'cleanup']);
    expect(attachment.write(utf8('again'))).toMatchObject({
      disposition: 'failed',
      reason: 'stale-generation',
    });
    expect(attachment.resize(80, 24)).toMatchObject({
      disposition: 'failed',
      reason: 'stale-generation',
    });
  });
});

describe('liveness', () => {
  test('expiry freezes input and revokes the attachment', async () => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness);
    harness.clock.advance(29_999);
    expect(harness.session.snapshot.connection.kind).toBe('attached');
    harness.clock.advance(1);
    expect(harness.session.snapshot.connection).toEqual({ kind: 'revoked', generation: 1 });
    expect(attachment.write(utf8('x'))).toMatchObject({ reason: 'stale-generation' });
    await flush();
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('liveness-expired');
  });

  test('a heartbeat resets the deadline and grants no authority', async () => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness, 'read-only');
    harness.clock.advance(20_000);
    expect(attachment.heartbeat()).toBe(true);
    harness.clock.advance(20_000);
    expect(harness.session.snapshot.connection.kind).toBe('attached');
    expect(attachment.write(utf8('x'))).toMatchObject({ reason: 'read-only' });
    harness.clock.advance(10_000);
    expect(harness.session.snapshot.connection.kind).toBe('revoked');
    expect(attachment.heartbeat()).toBe(false);
    await flush();
  });
});
