import { describe, expect, test } from 'bun:test';

import type { ByteReader, ByteStream } from '../session/session-types.ts';
import { createDeferredByteStream } from './deferred-byte-stream.ts';

/** A source whose reader a test drives, recording how it was used. */
function source(chunks: readonly string[], options: { withoutCancel?: boolean } = {}) {
  const log: string[] = [];
  const pending = [...chunks];
  const reader: ByteReader = {
    read: () => {
      log.push('read');
      const next = pending.shift();
      return Promise.resolve(
        next === undefined
          ? { done: true }
          : { done: false, value: new TextEncoder().encode(next) },
      );
    },
    releaseLock: () => {
      log.push('release');
    },
    ...(options.withoutCancel === true
      ? {}
      : {
          cancel: () => {
            log.push('cancel');
            return Promise.resolve();
          },
        }),
  };
  const stream: ByteStream = {
    getReader: () => {
      log.push('lock');
      return reader;
    },
  };
  return { stream, log };
}

describe('a byte stream attached after the session has taken its reader', () => {
  test('takes the lock on the source the moment it is attached, before anything is read', () => {
    const deferred = createDeferredByteStream();
    const { stream, log } = source(['a']);
    deferred.attach(stream);
    expect(log).toEqual(['lock']);
  });

  test('a read made before the attachment waits for it, then delivers the source in order', async () => {
    const deferred = createDeferredByteStream();
    const reader = deferred.stream.getReader();
    const early = reader.read();
    const { stream } = source(['one', 'two']);
    deferred.attach(stream);
    const first = await early;
    expect(first.done ? '' : new TextDecoder().decode(first.value)).toBe('one');
    const second = await reader.read();
    expect(second.done ? '' : new TextDecoder().decode(second.value)).toBe('two');
    const awaited4 = await reader.read();
    expect(awaited4.done).toBe(true);
  });

  test('releases the source once its end is read, and cancel afterwards touches nothing', async () => {
    const deferred = createDeferredByteStream();
    const { stream, log } = source([]);
    deferred.attach(stream);
    const reader = deferred.stream.getReader();
    const awaited5 = await reader.read();
    expect(awaited5.done).toBe(true);
    expect(log).toEqual(['lock', 'read', 'release']);
    await deferred.cancel();
    expect(log).toEqual(['lock', 'read', 'release']);
  });

  test('cancels the source once however many times it is asked, and then lets it go', async () => {
    const deferred = createDeferredByteStream();
    const { stream, log } = source(['x']);
    deferred.attach(stream);
    const reader = deferred.stream.getReader();
    await Promise.all([reader.cancel?.(), deferred.cancel(), deferred.cancel()]);
    expect(log).toEqual(['lock', 'cancel', 'release']);
    reader.releaseLock();
    expect(() => deferred.stream.getReader()).not.toThrow();
  });

  test('a source that cannot be canceled is still let go', async () => {
    const deferred = createDeferredByteStream();
    const { stream, log } = source(['x'], { withoutCancel: true });
    deferred.attach(stream);
    await deferred.cancel();
    expect(log).toEqual(['lock', 'release']);
  });

  test('cancel before any attachment ends the stream, and a late attachment is locked and let go', async () => {
    const deferred = createDeferredByteStream();
    const reader = deferred.stream.getReader();
    const waiting = reader.read();
    await deferred.cancel();
    const awaited6 = await waiting;
    expect(awaited6.done).toBe(true);
    const { stream, log } = source(['x'], { withoutCancel: false });
    deferred.attach(stream);
    expect(log.slice(0, 2)).toEqual(['lock', 'cancel']);
    const awaited7 = await reader.read();
    expect(awaited7.done).toBe(true);
  });

  test('a late attachment that cannot be canceled is only locked', async () => {
    const deferred = createDeferredByteStream();
    await deferred.cancel();
    const { stream, log } = source(['x'], { withoutCancel: true });
    deferred.attach(stream);
    expect(log).toEqual(['lock']);
  });

  test('refuses a second reader while the first holds the stream', () => {
    const deferred = createDeferredByteStream();
    const reader = deferred.stream.getReader();
    expect(() => deferred.stream.getReader()).toThrow(TypeError);
    reader.releaseLock();
    expect(() => deferred.stream.getReader()).not.toThrow();
  });
});
