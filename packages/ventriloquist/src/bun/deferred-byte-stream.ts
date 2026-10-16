import type { ByteReader, ByteReadResult, ByteStream } from '../session/session-types.ts';

/** A byte stream the session can take a reader on before the process that feeds it exists. */
export type DeferredByteStream = {
  readonly stream: ByteStream;
  /**
   * Hand over the child's output stream. The lock on it is taken here, synchronously: Bun buffers
   * a subprocess's output without bound until something holds a reader on it (a flooding producer
   * reached 13.8 GB in six seconds), so this must run in the same turn as the spawn. From then on
   * the child is read only when the session asks, and a child that is not read is blocked by the
   * kernel's pipe buffer.
   */
  attach(source: ByteStream): void;
  /** Cancel what was attached, or end the stream if nothing ever was. Idempotent. */
  cancel(): Promise<void>;
};

/**
 * One session-facing reader over a stream that is attached later. A read before `attach` waits for
 * it; a cancel before `attach` ends the stream, so a session closed before its process started
 * never waits for output that cannot come.
 */
export function createDeferredByteStream(): DeferredByteStream {
  let inner: ByteReader | undefined;
  let canceled = false;
  let innerReleased = false;
  let locked = false;
  let wake: (() => void) | undefined;
  const attached = new Promise<void>((resolve) => {
    wake = resolve;
  });

  const releaseInner = (): void => {
    if (innerReleased) return;
    innerReleased = true;
    inner?.releaseLock();
  };

  const read = async (): Promise<ByteReadResult> => {
    await attached;
    if (inner === undefined || canceled) return { done: true };
    const result = await inner.read();
    // The end of the output ends the claim on it, as a pump that reads to the end would.
    if (result.done) releaseInner();
    return result;
  };

  let canceling: Promise<void> | undefined;
  const cancel = (): Promise<void> => {
    // The session cancels its reader and the backend cancels again at cleanup; a reader whose lock
    // was released cannot be canceled a second time.
    canceling ??= (async () => {
      canceled = true;
      wake?.();
      if (!innerReleased) await inner?.cancel?.();
      releaseInner();
    })();
    return canceling;
  };

  const stream: ByteStream = {
    getReader: (): ByteReader => {
      if (locked) throw new TypeError('the output stream already has a reader');
      locked = true;
      return {
        read,
        cancel,
        releaseLock: () => {
          locked = false;
        },
      };
    },
  };

  return {
    stream,
    attach: (source) => {
      inner = source.getReader();
      // Canceled before the process existed: the lock is still taken, so nothing is buffered, and the child is let go.
      if (canceled) void inner.cancel?.();
      wake?.();
    },
    cancel,
  };
}
