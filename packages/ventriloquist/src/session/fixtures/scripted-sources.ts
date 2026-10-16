import type { OutputChannel } from '../../protocol/messages.ts';
import type { ByteReader, ByteReadResult, ByteStream, OutputSource } from '../session-types.ts';

/** How a scripted owned source answers a request to release it. */
export type ReleaseBehavior = 'resolve' | 'reject' | 'hang' | 'absent';

type Waiter = {
  resolve(result: ByteReadResult): void;
  reject(error: unknown): void;
};

/** A byte feed a test pushes into: a queue of chunks, an end, or an error, delivered to waiting reads in order. */
class Feed {
  readonly #chunks: Uint8Array[];
  readonly #waiters: Waiter[];
  #ended: boolean;
  #error: { readonly error: unknown } | undefined;

  constructor() {
    this.#chunks = [];
    this.#waiters = [];
    this.#ended = false;
  }

  push(bytes: Uint8Array): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#chunks.push(bytes);
    else waiter.resolve({ done: false, value: bytes });
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true });
  }

  fail(error: unknown): void {
    this.#error = { error };
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<ByteReadResult> {
    const chunk = this.#chunks.shift();
    if (chunk !== undefined) return Promise.resolve({ done: false, value: chunk });
    if (this.#error !== undefined) return Promise.reject(this.#error.error);
    if (this.#ended) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }
}

function releaseWith(behavior: ReleaseBehavior): Promise<void> {
  if (behavior === 'reject') return Promise.reject(new Error('release failed'));
  if (behavior === 'hang') return new Promise(() => undefined);
  return Promise.resolve();
}

export type ScriptedStream = {
  readonly stream: ByteStream;
  readonly source: OutputSource;
  push(bytes: Uint8Array): void;
  end(): void;
  fail(error: unknown): void;
  /** How many times the reader was canceled, and whether its lock was released. */
  readonly cancelCount: number;
  readonly lockReleased: boolean;
  /** How many times the session asked the stream for a chunk: a paused source is not asked. */
  readonly readCount: number;
};

/** An owned stream. `cancel: 'absent'` models a reader that cannot be canceled at all. */
export function createScriptedStream(
  channel: OutputChannel = 'pty',
  options: { readonly cancel?: ReleaseBehavior; readonly releaseLock?: () => void } = {},
): ScriptedStream {
  const feed = new Feed();
  const behavior = options.cancel ?? 'resolve';
  let cancelCount = 0;
  let lockReleased = false;
  let readCount = 0;
  const reader: ByteReader = {
    read: () => {
      readCount += 1;
      return feed.next();
    },
    releaseLock: () => {
      options.releaseLock?.();
      lockReleased = true;
    },
    ...(behavior === 'absent'
      ? {}
      : {
          cancel: () => {
            cancelCount += 1;
            feed.end();
            return releaseWith(behavior);
          },
        }),
  };
  const stream: ByteStream = { getReader: () => reader };
  return {
    stream,
    source: { kind: 'stream', channel, stream },
    push: (bytes) => feed.push(bytes),
    end: () => feed.end(),
    fail: (error) => feed.fail(error),
    get cancelCount() {
      return cancelCount;
    },
    get lockReleased() {
      return lockReleased;
    },
    get readCount() {
      return readCount;
    },
  };
}

export type ScriptedIterable = {
  readonly source: OutputSource;
  push(bytes: Uint8Array): void;
  end(): void;
  fail(error: unknown): void;
  readonly returnCount: number;
};

/** An owned async iterable. `return: 'absent'` models an iterator with no `return()` method. */
export function createScriptedIterable(
  channel: OutputChannel = 'stdout',
  options: { readonly return?: ReleaseBehavior } = {},
): ScriptedIterable {
  const feed = new Feed();
  const behavior = options.return ?? 'resolve';
  let returnCount = 0;
  const iterator: AsyncIterator<Uint8Array> = {
    next: () => feed.next() as Promise<IteratorResult<Uint8Array>>,
    ...(behavior === 'absent'
      ? {}
      : {
          return: async () => {
            returnCount += 1;
            feed.end();
            await releaseWith(behavior);
            return { done: true as const, value: undefined };
          },
        }),
  };
  return {
    source: { kind: 'iterable', channel, iterable: { [Symbol.asyncIterator]: () => iterator } },
    push: (bytes) => feed.push(bytes),
    end: () => feed.end(),
    fail: (error) => feed.fail(error),
    get returnCount() {
      return returnCount;
    },
  };
}

export type ScriptedSubscription = {
  readonly source: OutputSource;
  /** The producer keeps running: it calls the last subscriber even after that subscriber unsubscribed. */
  push(bytes: Uint8Array): void;
  end(): void;
  readonly subscribed: boolean;
  readonly unsubscribeCount: number;
};

/** A borrowed subscription whose producer keeps running; `unsubscribe` is the only thing cleanup may call. */
export function createScriptedSubscription(
  channel: OutputChannel = 'stdout',
  options: { readonly unsubscribe?: ReleaseBehavior | 'throw' } = {},
): ScriptedSubscription {
  let deliver: ((bytes: Uint8Array) => void) | undefined;
  let finish: (() => void) | undefined;
  let subscribed = false;
  let unsubscribeCount = 0;
  const behavior = options.unsubscribe ?? 'resolve';
  return {
    source: {
      kind: 'subscription',
      channel,
      subscribe: (onBytes, onEnd) => {
        deliver = onBytes;
        finish = onEnd;
        subscribed = true;
        return () => {
          unsubscribeCount += 1;
          subscribed = false;
          if (behavior === 'throw') throw new Error('unsubscribe failed');
          return releaseWith(behavior === 'absent' ? 'resolve' : behavior);
        };
      },
    },
    push: (bytes) => deliver?.(bytes),
    end: () => finish?.(),
    get subscribed() {
      return subscribed;
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    },
  };
}
