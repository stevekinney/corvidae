import { writeSync } from 'node:fs';

import type { ByteReader, ByteReadResult, ByteStream } from '../session/session-types.ts';
import type { PtyDevice } from './pty-device.ts';
import {
  MASTER_FLAG_COUNT,
  MASTER_FLAGS,
  type MasterEnd,
  type MasterMessage,
} from './pty-master-loop.ts';

/** The slice of a `Worker` the master uses. */
export type MasterWorker = {
  addEventListener(type: 'message', listener: (event: MessageEvent<MasterMessage>) => void): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
};

/** Writes `bytes` from `offset` to the master without blocking; throws an error with an errno `code`. */
export type MasterWrite = (descriptor: number, bytes: Uint8Array, offset: number) => number;

export type PtyMasterOptions = {
  readonly descriptor: number;
  readonly device: PtyDevice;
  /** Whether the kernel ends a terminal's output with `EIO` (Linux) rather than end of file (macOS). */
  readonly endsWithIo: boolean;
  readonly createWorker?: () => MasterWorker;
  readonly write?: MasterWrite;
  /** How long `stop` waits for the worker to say it ended. */
  readonly stopTimeoutMilliseconds?: number;
};

export type PtyMaster = {
  /** The terminal's output, read from the kernel only as fast as the session takes it. */
  readonly stream: ByteStream;
  /**
   * Write input. The master is non-blocking, so what the child has not read is queued here and
   * retried; the returned promise settles when every byte is in the kernel. Input to a terminal
   * whose other end is gone never settles, and the session reports it as unknown at close.
   */
  write(bytes: Uint8Array): Promise<void>;
  /** Keep reading but drop the output, so a terminal that is closing can drain. */
  discard(): void;
  /** End the worker and wait for it; `false` means it did not answer in time and was terminated. */
  stop(): Promise<boolean>;
  /** Abandon queued input and close the descriptor. Call once, after `stop`. */
  close(): void;
};

const WRITE_RETRY_MILLISECONDS = [1, 2, 4, 8, 16];

const defaultWrite: MasterWrite = (descriptor, bytes, offset) =>
  writeSync(descriptor, bytes, offset, bytes.length - offset, null);

function defaultWorker(): MasterWorker {
  return new Worker(new URL('./pty-master-worker.ts', import.meta.url).href);
}

/** Whether `error` says the other end of the terminal is gone, so no write can ever land. */
function isHungUp(error: unknown): boolean {
  const code = (error as { readonly code?: string }).code;
  return code === 'EIO' || code === 'EPIPE' || code === 'ENXIO';
}

type QueuedWrite = {
  readonly bytes: Uint8Array;
  offset: number;
  resolve(): void;
  reject(error: unknown): void;
};

type Ending = { readonly how: MasterEnd; readonly code?: string };

/**
 * Own the master side of a PTY: a worker thread reads it behind a credit window, this thread
 * writes it. The read side is what makes output pausable. Bun's own terminal reader cannot be
 * stopped, but a descriptor nobody polls fills the kernel's buffer and blocks the producer.
 */
export function createPtyMaster(options: PtyMasterOptions): PtyMaster {
  const { descriptor, device } = options;
  const writeBytes = options.write ?? defaultWrite;
  const shared = new SharedArrayBuffer(MASTER_FLAG_COUNT * Int32Array.BYTES_PER_ELEMENT);
  const flags = new Int32Array(shared);
  const worker = (options.createWorker ?? defaultWorker)();
  const queue: Uint8Array[] = [];
  let waiter: { resolve(result: ByteReadResult): void; reject(error: unknown): void } | undefined;
  let ending: Ending | undefined;
  let canceled = false;
  let locked = false;
  let closed = false;
  let workerGone = false;
  let onWorkerEnd: (() => void) | undefined;

  const endResult = (): ByteReadResult | Error => {
    if (ending === undefined || ending.how === 'stopped') return { done: true };
    if (ending.how === 'eof' || (ending.how === 'eio' && options.endsWithIo)) return { done: true };
    return new Error(`the terminal could not be read (${ending.code ?? ending.how})`);
  };

  worker.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'data') {
      if (canceled) {
        Atomics.sub(flags, MASTER_FLAGS.inflight, message.chunk.byteLength);
        return;
      }
      const chunk = new Uint8Array(message.chunk);
      if (waiter !== undefined) {
        const waiting = waiter;
        waiter = undefined;
        Atomics.sub(flags, MASTER_FLAGS.inflight, chunk.length);
        Atomics.notify(flags, MASTER_FLAGS.inflight);
        waiting.resolve({ done: false, value: chunk });
      } else {
        queue.push(chunk);
      }
      return;
    }
    ending =
      message.code === undefined ? { how: message.how } : { how: message.how, code: message.code };
    workerGone = true;
    onWorkerEnd?.();
    if (waiter !== undefined && queue.length === 0) {
      const waiting = waiter;
      waiter = undefined;
      const result = endResult();
      if (result instanceof Error) waiting.reject(result);
      else waiting.resolve(result);
    }
  });
  worker.postMessage({ fd: descriptor, shared }, []);

  const take = (): ByteReadResult | Error | undefined => {
    const chunk = queue.shift();
    if (chunk !== undefined) {
      // Taking a chunk is what returns credit to the worker; a session that is not reading never does.
      Atomics.sub(flags, MASTER_FLAGS.inflight, chunk.length);
      Atomics.notify(flags, MASTER_FLAGS.inflight);
      return { done: false, value: chunk };
    }
    if (canceled) return { done: true };
    return ending === undefined ? undefined : endResult();
  };

  const reader: ByteReader = {
    read: () => {
      const ready = take();
      if (ready instanceof Error) return Promise.reject(ready);
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
    cancel: () => {
      canceled = true;
      queue.length = 0;
      Atomics.store(flags, MASTER_FLAGS.inflight, 0);
      Atomics.store(flags, MASTER_FLAGS.discard, 1);
      Atomics.notify(flags, MASTER_FLAGS.inflight);
      const waiting = waiter;
      waiter = undefined;
      waiting?.resolve({ done: true });
      return Promise.resolve();
    },
    releaseLock: () => {
      locked = false;
    },
  };
  const stream: ByteStream = {
    getReader: () => {
      if (locked) throw new TypeError('the output stream already has a reader');
      locked = true;
      return reader;
    },
  };

  // ---- input ---------------------------------------------------------------------------------
  const pending: QueuedWrite[] = [];
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;

  const flush = (): void => {
    retryTimer = undefined;
    for (;;) {
      if (closed || pending.length === 0) return;
      const head = pending[0] as QueuedWrite;
      try {
        head.offset += writeBytes(descriptor, head.bytes, head.offset);
      } catch (error) {
        const code = (error as { readonly code?: string }).code;
        if (code === 'EAGAIN') {
          // The child has not read what is already queued: wait, longer each time, and try again.
          const delay = WRITE_RETRY_MILLISECONDS[
            Math.min(retries, WRITE_RETRY_MILLISECONDS.length - 1)
          ] as number;
          retries += 1;
          retryTimer = setTimeout(flush, delay);
          return;
        }
        // A terminal whose other end is gone will never take this write: it stays unsettled.
        if (isHungUp(error)) return;
        pending.shift()?.reject(error);
        continue;
      }
      retries = 0;
      if (head.offset >= head.bytes.length) {
        pending.shift();
        head.resolve();
      }
    }
  };

  // ---- ending ----------------------------------------------------------------------------------
  return {
    stream,
    write: (bytes) => {
      if (bytes.length === 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        pending.push({ bytes: bytes.slice(), offset: 0, resolve, reject });
        if (pending.length === 1 && retryTimer === undefined) flush();
      });
    },
    discard: () => {
      Atomics.store(flags, MASTER_FLAGS.discard, 1);
      Atomics.notify(flags, MASTER_FLAGS.inflight);
    },
    stop: async () => {
      Atomics.store(flags, MASTER_FLAGS.stop, 1);
      Atomics.notify(flags, MASTER_FLAGS.inflight);
      let graceful = workerGone;
      if (!workerGone) {
        graceful = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), options.stopTimeoutMilliseconds ?? 2000);
          onWorkerEnd = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
      }
      worker.terminate();
      return graceful;
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      pending.length = 0;
      device.close(descriptor);
    },
  };
}
