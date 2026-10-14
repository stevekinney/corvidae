import { describe, expect, test } from 'bun:test';

import { createDeferred } from './fixtures/deferred.ts';
import {
  createScriptedIterable,
  createScriptedStream,
  createScriptedSubscription,
  type ReleaseBehavior,
} from './fixtures/scripted-sources.ts';
import type { AttachmentListener, SessionEvent } from './session-types.ts';
import {
  createHarness,
  expectNoOutputAfterClosed,
  flush,
  startAndAttach,
  utf8,
} from './session.test-support.ts';

describe('revoke versus input', () => {
  test('a write that never settles is reported unknown at close, and nothing is submitted afterwards', async () => {
    const harness = createHarness({ backend: { write: () => new Promise(() => undefined) } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('in flight'));
    await flush();
    attachment.write(utf8('queued'));
    attachment.stop();
    // Revocation is synchronous: input is already frozen when stop returns.
    expect(attachment.write(utf8('late'))).toMatchObject({
      disposition: 'failed',
      reason: 'stale-generation',
    });
    expect(harness.session.snapshot.connection).toEqual({ kind: 'revoked', generation: 1 });
    await harness.session.closed;
    expect(harness.recorder.ofType('operationResult')).toEqual([
      {
        type: 'operationResult',
        sequence: 2,
        kind: 'input',
        disposition: 'canceled',
        reason: 'revoked',
      },
      {
        type: 'operationResult',
        sequence: 1,
        kind: 'input',
        disposition: 'unknown',
        reason: 'closed-before-acknowledgement',
      },
    ]);
    expect(harness.backend?.calls.filter((call) => call.call === 'write')).toHaveLength(1);
    expectNoOutputAfterClosed(harness.recorder.events);
    expect(harness.clock.pendingTimers).toBe(0);
  });

  test('a write the backend settles after revocation is still reported, once', async () => {
    const barrier = createDeferred<void>();
    const harness = createHarness({ backend: { write: () => barrier.promise } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('in flight'));
    await flush();
    const closing = attachment.detach();
    barrier.reject(new Error('EPIPE'));
    await closing;
    expect(harness.recorder.ofType('operationResult')).toEqual([
      {
        type: 'operationResult',
        sequence: 1,
        kind: 'input',
        disposition: 'failed',
        reason: 'backend-failed',
      },
    ]);
    const summary = await closing;
    expect(summary.cause).toBe('disconnect');
  });
});

describe('queued resize versus stop', () => {
  test('stop cancels the unsent resize explicitly and the backend never sees it', async () => {
    const harness = createHarness({ backend: { write: () => new Promise(() => undefined) } });
    const attachment = await startAndAttach(harness);
    attachment.write(utf8('hold the FIFO'));
    await flush();
    attachment.resize(120, 50);
    const receipt = attachment.stop();
    expect(receipt.accepted).toBe(true);
    await harness.session.closed;
    expect(harness.recorder.ofType('operationResult')[0]).toEqual({
      type: 'operationResult',
      sequence: 2,
      kind: 'resize',
      disposition: 'canceled',
      reason: 'revoked',
    });
    expect(harness.backend?.calls.filter((call) => call.call === 'resize')).toEqual([]);
  });

  test('a resize that already reached the backend is not retracted', async () => {
    const barrier = createDeferred<void>();
    const harness = createHarness({ backend: { resize: () => barrier.promise } });
    const attachment = await startAndAttach(harness);
    attachment.resize(120, 50);
    await flush();
    attachment.stop();
    await flush();
    expect(harness.backend?.calls.filter((call) => call.call === 'resize')).toHaveLength(1);
    barrier.resolve();
    await harness.session.closed;
    expect(harness.recorder.ofType('operationResult')).toEqual([
      {
        type: 'operationResult',
        sequence: 1,
        kind: 'resize',
        disposition: 'unknown',
        reason: 'closed-before-acknowledgement',
      },
    ]);
  });
});

describe('callback rejection', () => {
  function failingListener(
    shouldFail: (event: SessionEvent) => boolean,
    mode: 'throw' | 'reject',
  ): { listener: AttachmentListener; seen: SessionEvent[] } {
    const seen: SessionEvent[] = [];
    const listener: AttachmentListener = (event) => {
      seen.push(event);
      if (!shouldFail(event)) return undefined;
      if (mode === 'throw') throw new Error('listener failed');
      return Promise.reject(new Error('listener failed'));
    };
    return { listener, seen };
  }

  test.each(['throw', 'reject'] as const)(
    'a listener that %ss on output revokes the attachment and runs cleanup',
    async (mode) => {
      const harness = createHarness();
      const { listener, seen } = failingListener((event) => event.type === 'output', mode);
      harness.session.attach({ requestedMode: 'interactive', grant: 'interactive', listener });
      void harness.session.start();
      await flush();
      harness.stream.push(utf8('boom'));
      await flush();
      const summary = await harness.session.closed;
      expect(summary).toMatchObject({ cause: 'callback-failed', cleanup: 'complete' });
      expect(harness.backend?.calls.filter((call) => call.call === 'cleanup')).toHaveLength(1);
      // The failed listener hears nothing more, not even that it was revoked.
      expect(seen.map((event) => event.type)).toEqual(['output']);
      expect(harness.session.snapshot.closed).toBe(true);
    },
  );

  test('a listener that throws while being told of the revocation does not loop or change the cause', async () => {
    const harness = createHarness();
    const { listener, seen } = failingListener(
      (event) => event.type === 'attachmentRevoked',
      'throw',
    );
    harness.session.attach({ requestedMode: 'interactive', grant: 'interactive', listener });
    void harness.session.start();
    await flush();
    await harness.session.dispose();
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('host-dispose');
    expect(seen.map((event) => event.type)).toEqual(['attachmentRevoked']);
  });

  test('a listener that throws on the final report still lets the session close', async () => {
    const harness = createHarness();
    const { listener } = failingListener((event) => event.type === 'sessionClosed', 'throw');
    harness.session.attach({ requestedMode: 'interactive', grant: 'interactive', listener });
    void harness.session.start();
    await flush();
    const summary = await harness.session.dispose();
    expect(summary.cause).toBe('host-dispose');
    expect(harness.session.snapshot.closed).toBe(true);
  });

  test('a listener that fails on an operation result cancels the rest of the queue', async () => {
    const barrier = createDeferred<void>();
    const harness = createHarness({ backend: { write: () => barrier.promise } });
    const { listener, seen } = failingListener(
      (event) => event.type === 'operationResult' && event.disposition === 'canceled',
      'throw',
    );
    const result = harness.session.attach({
      requestedMode: 'interactive',
      grant: 'interactive',
      listener,
    });
    void harness.session.start();
    await flush();
    if (!result.accepted) throw new Error('refused');
    result.attachment.write(utf8('a'));
    result.attachment.write(utf8('b'));
    result.attachment.write(utf8('c'));
    result.attachment.stop();
    barrier.resolve();
    await harness.session.closed;
    expect(seen.filter((event) => event.type === 'operationResult')).toHaveLength(1);
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('attachment-stop');
  });
});

describe('disconnect and revocation', () => {
  test('a disconnect freezes input at once, revokes authority and cleans up', async () => {
    const harness = createHarness();
    const attachment = await startAndAttach(harness);
    const closing = attachment.detach();
    expect(harness.session.snapshot.connection).toEqual({ kind: 'revoked', generation: 1 });
    expect(attachment.write(utf8('x'))).toMatchObject({ reason: 'stale-generation' });
    const summary = await closing;
    expect(summary).toMatchObject({ cause: 'disconnect', cleanup: 'complete', quarantined: false });
    expect(harness.recorder.ofType('attachmentRevoked')).toEqual([
      { type: 'attachmentRevoked', generation: 1, cause: 'disconnect' },
    ]);
  });

  test('withdrawing authorization is the same close with its own cause', async () => {
    const harness = createHarness();
    await startAndAttach(harness);
    const summary = await harness.session.revokeAuthorization();
    expect(summary.cause).toBe('authorization-revoked');
  });

  test('a source that errors fails the session instead of ending it quietly', async () => {
    const harness = createHarness();
    await startAndAttach(harness);
    harness.stream.fail(new Error('read failed'));
    await flush();
    expect(await harness.session.closed).toMatchObject({
      cause: 'source-failed',
      cleanup: 'complete',
    });
    // An errored stream has nothing left to cancel; its lock is released.
    expect(harness.stream.cancelCount).toBe(0);
    expect(harness.stream.lockReleased).toBe(true);
  });

  test('a subscription that throws on subscribe fails the session', async () => {
    const throwing = {
      kind: 'subscription' as const,
      channel: 'stdout' as const,
      subscribe: () => {
        throw new Error('subscribe failed');
      },
    };
    const harness = createHarness({ backend: false, sources: [throwing] });
    await startAndAttach(harness);
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('source-failed');
  });

  test('output the producer reuses its buffer for is copied before it is accepted', async () => {
    const harness = createHarness();
    await startAndAttach(harness);
    const buffer = utf8('abc');
    harness.stream.push(buffer);
    await flush();
    buffer.fill(0);
    const [event] = harness.recorder.ofType('output');
    expect(event?.bytes).toEqual(utf8('abc'));
    expect(event).toMatchObject({ generation: 1, channel: 'pty' });
  });
});

const BEHAVIORS: readonly [ReleaseBehavior, 'complete' | 'incomplete' | 'unknown'][] = [
  ['resolve', 'complete'],
  ['reject', 'incomplete'],
  ['absent', 'incomplete'],
  ['hang', 'unknown'],
];

describe('cleanup of owned and borrowed sources', () => {
  test.each(BEHAVIORS)('an owned stream whose cancel %s reports %s', async (cancel, expected) => {
    const stream = createScriptedStream('stdout', { cancel });
    const harness = createHarness({ backend: false, sources: [stream.source] });
    await startAndAttach(harness, 'read-only');
    const closing = harness.session.dispose();
    await flush();
    harness.clock.advance(5_000);
    const summary = await closing;
    expect(summary.cleanup).toBe(expected);
    expect(summary.quarantined).toBe(expected !== 'complete');
    expect(stream.cancelCount).toBe(cancel === 'absent' ? 0 : 1);
    expect(stream.lockReleased).toBe(expected === 'complete');
  });

  test('an owned stream whose releaseLock throws is incomplete', async () => {
    const stream = createScriptedStream('stdout', {
      releaseLock: () => {
        throw new Error('still locked');
      },
    });
    const harness = createHarness({ backend: false, sources: [stream.source] });
    await startAndAttach(harness, 'read-only');
    const summary = await harness.session.dispose();
    expect(summary.cleanup).toBe('incomplete');
  });

  test('an owned stream that already ended is only released, never canceled', async () => {
    const stream = createScriptedStream('stdout');
    const harness = createHarness({ backend: false, sources: [stream.source] });
    const attachment = await startAndAttach(harness, 'read-only');
    stream.push(utf8('end'));
    stream.end();
    await flush();
    attachment.outputParsedThrough(3);
    await flush();
    expect(await harness.session.closed).toMatchObject({
      cause: 'source-complete',
      cleanup: 'complete',
    });
    expect(stream.cancelCount).toBe(0);
    expect(stream.lockReleased).toBe(true);
  });

  test.each(BEHAVIORS)(
    'an owned iterator whose return() %s reports %s',
    async (behavior, expected) => {
      const iterable = createScriptedIterable('stdout', { return: behavior });
      const harness = createHarness({ backend: false, sources: [iterable.source] });
      await startAndAttach(harness, 'read-only');
      const closing = harness.session.dispose();
      await flush();
      harness.clock.advance(5_000);
      const summary = await closing;
      expect(summary.cleanup).toBe(expected);
      expect(iterable.returnCount).toBe(behavior === 'absent' ? 0 : 1);
    },
  );

  test('an owned iterable delivers copies of what it yields, in order, on its own channel', async () => {
    const iterable = createScriptedIterable('stderr');
    const harness = createHarness({ backend: { mode: 'pipe' }, sources: [iterable.source] });
    await startAndAttach(harness, 'read-only');
    const first = utf8('one');
    iterable.push(first);
    iterable.push(utf8('two'));
    await flush();
    first.fill(0);
    expect(harness.recorder.ofType('output').map((event) => [event.channel, event.bytes])).toEqual([
      ['stderr', utf8('one')],
      ['stderr', utf8('two')],
    ]);
  });

  test('an owned iterator that already finished does not get return()', async () => {
    const iterable = createScriptedIterable('stdout');
    const harness = createHarness({ backend: false, sources: [iterable.source] });
    await startAndAttach(harness, 'read-only');
    iterable.end();
    await flush();
    expect(await harness.session.closed).toMatchObject({
      cause: 'source-complete',
      cleanup: 'complete',
    });
    expect(iterable.returnCount).toBe(0);
  });

  test('an iterable that throws fails the session', async () => {
    const iterable = createScriptedIterable('stdout');
    const harness = createHarness({ backend: false, sources: [iterable.source] });
    await startAndAttach(harness, 'read-only');
    iterable.fail(new Error('iteration failed'));
    await flush();
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('source-failed');
  });

  test.each([
    ['resolve', 'complete'],
    ['reject', 'incomplete'],
    ['throw', 'incomplete'],
    ['hang', 'unknown'],
  ] as const)(
    'a borrowed subscription whose unsubscribe %ss reports %s and the producer keeps running',
    async (unsubscribe, expected) => {
      const subscription = createScriptedSubscription('stdout', { unsubscribe });
      const harness = createHarness({ backend: false, sources: [subscription.source] });
      await startAndAttach(harness, 'read-only');
      const closing = harness.session.dispose();
      await flush();
      harness.clock.advance(5_000);
      const summary = await closing;
      expect(summary.cleanup).toBe(expected);
      expect(subscription.unsubscribeCount).toBe(1);
      expect(subscription.subscribed).toBe(false);
      // Nothing owned the producer, so it carries on; the session simply no longer listens.
      subscription.push(utf8('still producing'));
      subscription.end();
      await flush();
      expect(harness.recorder.ofType('output')).toEqual([]);
      expectNoOutputAfterClosed(harness.recorder.events);
    },
  );

  test('a borrowed source that never started has nothing to unsubscribe', async () => {
    const subscription = createScriptedSubscription();
    const harness = createHarness({ backend: false, sources: [subscription.source] });
    const summary = await harness.session.dispose();
    expect(summary.cleanup).toBe('complete');
    expect(subscription.unsubscribeCount).toBe(0);
  });

  test('the least certain outcome across the backend and every source wins', async () => {
    const owned = createScriptedStream('stdout', { cancel: 'reject' });
    const borrowed = createScriptedSubscription('stderr');
    const harness = createHarness({
      backend: { mode: 'pipe', cleanup: () => new Promise(() => undefined) },
      sources: [owned.source, borrowed.source],
    });
    await startAndAttach(harness);
    const closing = harness.session.dispose();
    await flush();
    harness.clock.advance(5_000);
    const summary = await closing;
    expect(summary.cleanup).toBe('unknown');
    expect(owned.cancelCount).toBe(1);
    expect(borrowed.unsubscribeCount).toBe(1);
  });

  test('a backend whose cleanup rejects is incomplete, and one that reports it is believed', async () => {
    const rejecting = createHarness({ backend: { cleanup: () => Promise.reject(new Error('x')) } });
    await startAndAttach(rejecting);
    const summary = await rejecting.session.dispose();
    expect(summary.cleanup).toBe('incomplete');
    const reporting = createHarness({ backend: { cleanup: () => Promise.resolve('unknown') } });
    await startAndAttach(reporting);
    expect(await reporting.session.dispose()).toMatchObject({
      cleanup: 'unknown',
      quarantined: true,
    });
  });

  test('a close with no attachment still releases every owned source', async () => {
    const stream = createScriptedStream('pty');
    const harness = createHarness({ sources: [stream.source] });
    await harness.session.dispose();
    expect(stream.cancelCount).toBe(1);
    expect(stream.lockReleased).toBe(true);
  });

  test('every source ends before an output-only session closes', async () => {
    const stdout = createScriptedSubscription('stdout');
    const stderr = createScriptedSubscription('stdout');
    const harness = createHarness({
      backend: false,
      sources: [stdout.source, stderr.source],
    });
    await startAndAttach(harness, 'read-only');
    stdout.end();
    await flush();
    expect(harness.session.snapshot.closed).toBe(false);
    stderr.end();
    await flush();
    expect(await harness.session.closed).toMatchObject({ cause: 'source-complete' });
  });
});

describe('construction failure', () => {
  test('a source that cannot be opened releases the readers already acquired', async () => {
    const first = createScriptedStream('stdout');
    const locked = {
      kind: 'stream' as const,
      channel: 'stdout' as const,
      stream: {
        getReader: (): never => {
          throw new TypeError('stream is locked');
        },
      },
    };
    expect(() => createHarness({ backend: false, sources: [first.source, locked] })).toThrow(
      'stream is locked',
    );
    await flush();
    expect(first.cancelCount).toBe(1);
    expect(first.lockReleased).toBe(true);
  });
});

describe('a source that fails part-way', () => {
  test('an iterator whose next() rejects is still asked to return()', async () => {
    const iterable = createScriptedIterable('stdout');
    const harness = createHarness({ backend: false, sources: [iterable.source] });
    await startAndAttach(harness, 'read-only');
    iterable.fail(new Error('read failed'));
    await flush();
    expect(await harness.session.closed).toMatchObject({
      cause: 'source-failed',
      cleanup: 'complete',
    });
    expect(iterable.returnCount).toBe(1);
  });

  test('a return() that rejects after a failed next() reports the real cleanup outcome', async () => {
    const iterable = createScriptedIterable('stdout', { return: 'reject' });
    const harness = createHarness({ backend: false, sources: [iterable.source] });
    await startAndAttach(harness, 'read-only');
    iterable.fail(new Error('read failed'));
    await flush();
    expect(await harness.session.closed).toMatchObject({
      cause: 'source-failed',
      cleanup: 'incomplete',
      quarantined: true,
    });
  });

  test('an iterator that finished normally is not asked to return()', async () => {
    const iterable = createScriptedIterable('stdout');
    const harness = createHarness({ backend: false, sources: [iterable.source] });
    await startAndAttach(harness, 'read-only');
    iterable.end();
    await flush();
    await harness.session.closed;
    expect(iterable.returnCount).toBe(0);
  });

  test('a subscribe() that throws without returning an unsubscribe handle quarantines the session', async () => {
    let registered = 0;
    const harness = createHarness({
      backend: false,
      sources: [
        {
          kind: 'subscription',
          channel: 'stdout',
          subscribe: () => {
            registered += 1;
            throw new Error('registered, then failed');
          },
        },
      ],
    });
    await startAndAttach(harness, 'read-only');
    expect(registered).toBe(1);
    expect(await harness.session.closed).toMatchObject({
      cause: 'source-failed',
      cleanup: 'incomplete',
      quarantined: true,
    });
  });

  test('a subscription that was never started releases completely', async () => {
    const harness = createHarness({
      backend: false,
      sources: [{ kind: 'subscription', channel: 'stdout', subscribe: () => () => undefined }],
    });
    expect(await harness.session.dispose()).toMatchObject({ cleanup: 'complete' });
  });
});
