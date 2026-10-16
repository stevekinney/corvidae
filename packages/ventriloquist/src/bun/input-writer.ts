import type { InputHold } from '../session/session-types.ts';

/** Writes `bytes` from `offset` to a non-blocking descriptor; throws an error with an errno `code`. */
export type DescriptorWrite = (descriptor: number, bytes: Uint8Array, offset: number) => number;

export type InputWriter = {
  /**
   * Write input. The descriptor is non-blocking, so what the child has not read is queued here and
   * retried; the returned promise settles when every byte is in the kernel. `hold` is told when the
   * write is waiting only because the child has not read what is already queued (`held`), and when
   * it stops waiting without having finished (`resumed`): progress, or a hang-up.
   */
  write(bytes: Uint8Array, hold?: InputHold): Promise<void>;
  /** Stop retrying and drop what is queued. Queued writes are neither taken nor refused, so the session reports them unknown. */
  abandon(): void;
};

export type InputWriterOptions = {
  readonly descriptor: number;
  readonly write: DescriptorWrite;
  /**
   * Whether `error` says the other end is gone, so no write can ever land. Such a write stays
   * unsettled and the session reports it unknown; any other error fails that write only.
   */
  readonly isHungUp: (error: unknown) => boolean;
};

const WRITE_RETRY_MILLISECONDS = [1, 2, 4, 8, 16];

type QueuedWrite = {
  readonly bytes: Uint8Array;
  offset: number;
  readonly hold: InputHold | undefined;
  /** `hold.held()` was reported and `resumed()` has not been since. */
  holding: boolean;
  resolve(): void;
  reject(error: unknown): void;
};

/**
 * The input side of a non-blocking descriptor, shared by the terminal's master and a pipe's
 * standard input. The kernel's buffer is the only buffer between the host and the child, so what a
 * child that never reads can hold is that buffer plus the one write in flight, which the session's
 * input budget bounds.
 */
export function createInputWriter(options: InputWriterOptions): InputWriter {
  const { descriptor } = options;
  const pending: QueuedWrite[] = [];
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let abandoned = false;

  const flush = (): void => {
    retryTimer = undefined;
    for (;;) {
      if (abandoned || pending.length === 0) return;
      const head = pending[0] as QueuedWrite;
      try {
        head.offset += options.write(descriptor, head.bytes, head.offset);
      } catch (error) {
        const code = (error as { readonly code?: string }).code;
        if (code === 'EAGAIN') {
          if (!head.holding && head.hold !== undefined) {
            head.holding = true;
            head.hold.held();
          }
          // The child has not read what is already queued: wait, longer each time, and try again.
          const delay = WRITE_RETRY_MILLISECONDS[
            Math.min(retries, WRITE_RETRY_MILLISECONDS.length - 1)
          ] as number;
          retries += 1;
          retryTimer = setTimeout(flush, delay);
          return;
        }
        // The other end is gone and will never take this write: it stays unsettled, and a wait that
        // was a hold is now a lost write, which the session times out as unknown.
        if (options.isHungUp(error)) {
          if (head.holding) {
            head.holding = false;
            head.hold?.resumed();
          }
          return;
        }
        pending.shift()?.reject(error);
        continue;
      }
      retries = 0;
      if (head.offset >= head.bytes.length) {
        pending.shift();
        head.resolve();
      } else if (head.holding) {
        // The child read some of it: the wait is over, though the write is not. If the queue fills
        // again the next retry reports a new hold.
        head.holding = false;
        head.hold?.resumed();
      }
    }
  };

  return {
    write: (bytes, hold) => {
      if (bytes.length === 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        pending.push({ bytes: bytes.slice(), offset: 0, hold, holding: false, resolve, reject });
        if (pending.length === 1 && retryTimer === undefined) flush();
      });
    },
    abandon: () => {
      abandoned = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      pending.length = 0;
    },
  };
}
