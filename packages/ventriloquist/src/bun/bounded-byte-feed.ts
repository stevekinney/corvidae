import type { ByteReader, ByteReadResult, ByteStream } from '../session/session-types.ts';

/** Raised through a feed when more output arrived unread than the host may buffer. */
export class OutputOverflowError extends Error {
  readonly maximumBufferedBytes: number;

  constructor(maximumBufferedBytes: number) {
    super(`unread process output exceeded ${maximumBufferedBytes} bytes`);
    this.name = 'OutputOverflowError';
    this.maximumBufferedBytes = maximumBufferedBytes;
  }
}

/**
 * Bytes that may sit unread across every feed holding the same budget. A process with several
 * output channels shares one, so its cap is per process, not per channel.
 */
export class ByteBudget {
  readonly maximumBytes: number;
  #used = 0;

  constructor(maximumBytes: number) {
    this.maximumBytes = maximumBytes;
  }

  /** Take `bytes` if they fit; otherwise take nothing and say so. */
  reserve(bytes: number): boolean {
    if (this.#used + bytes > this.maximumBytes) return false;
    this.#used += bytes;
    return true;
  }

  release(bytes: number): void {
    this.#used -= bytes;
  }
}

type Waiter = {
  resolve(result: ByteReadResult): void;
  reject(error: unknown): void;
};

/**
 * A byte stream the host fills and exactly one reader drains. A process's output cannot be paused,
 * so the feed is bounded instead: bytes are queued until the reader takes them, and the first chunk
 * that would push the unread total past the bound fails the feed visibly. Queued chunks are still
 * delivered before the failure, nothing is dropped silently, and every chunk is copied on the way
 * in so a producer that reuses its buffer cannot change what was accepted.
 *
 * The reader is the session's: it can be taken once at a time, and cancelling it ends the feed and
 * runs `onCancel`, which is how an owned source releases what feeds it.
 */
export class BoundedByteFeed {
  readonly stream: ByteStream;
  readonly #budget: ByteBudget;
  readonly #onCancel: () => void | Promise<void>;
  readonly #onOverflow: () => void;
  readonly #chunks: Uint8Array[] = [];
  readonly #waiters: Waiter[] = [];
  #heldBytes = 0;
  #ended = false;
  #canceled = false;
  #locked = false;
  #failure: { readonly error: unknown } | undefined;

  /**
   * `onOverflow` runs once, when unread output first exceeds the bound, whether or not a reader is
   * waiting: the failure is recorded for the reader to find, but the producer must not keep running
   * for a reader that may never come.
   */
  constructor(
    maximumBufferedBytes: number | ByteBudget,
    onCancel: () => void | Promise<void>,
    onOverflow: () => void = () => undefined,
  ) {
    this.#budget =
      typeof maximumBufferedBytes === 'number'
        ? new ByteBudget(maximumBufferedBytes)
        : maximumBufferedBytes;
    this.#onCancel = onCancel;
    this.#onOverflow = onOverflow;
    this.stream = { getReader: () => this.#acquire() };
  }

  /** Hand the reader a chunk, or queue it. A chunk that does not fit fails the feed instead. */
  push(bytes: Uint8Array): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: bytes.slice() });
      return;
    }
    if (!this.#budget.reserve(bytes.length)) {
      this.fail(new OutputOverflowError(this.#budget.maximumBytes));
      this.#onOverflow();
      return;
    }
    this.#chunks.push(bytes.slice());
    this.#heldBytes += bytes.length;
  }

  /** The producer reached end of file. Queued chunks are still delivered first. */
  end(): void {
    if (this.#closed) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true });
  }

  /** The producer failed. Queued chunks are still delivered first, then every read rejects. */
  fail(error: unknown): void {
    if (this.#closed) return;
    this.#failure = { error };
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  get #closed(): boolean {
    return this.#canceled || this.#ended || this.#failure !== undefined;
  }

  #acquire(): ByteReader {
    if (this.#locked) throw new TypeError('the output stream already has a reader');
    this.#locked = true;
    return {
      read: () => this.#read(),
      cancel: () => this.#cancel(),
      releaseLock: () => {
        this.#locked = false;
      },
    };
  }

  #read(): Promise<ByteReadResult> {
    const chunk = this.#chunks.shift();
    if (chunk !== undefined) {
      this.#heldBytes -= chunk.length;
      this.#budget.release(chunk.length);
      return Promise.resolve({ done: false, value: chunk });
    }
    if (this.#failure !== undefined) return Promise.reject(this.#failure.error);
    if (this.#ended || this.#canceled) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  async #cancel(): Promise<void> {
    if (this.#canceled) return;
    this.#canceled = true;
    this.#chunks.length = 0;
    this.#budget.release(this.#heldBytes);
    this.#heldBytes = 0;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true });
    await this.#onCancel();
  }
}
