import { writeSync } from 'node:fs';

import type {
  ByteReader,
  ByteReadResult,
  ByteStream,
  InputHold,
} from '../session/session-types.ts';
import { createInputWriter, type DescriptorWrite } from './input-writer.ts';
import type { PtyDevice } from './pty-device.ts';
import {
  MASTER_FLAG_COUNT,
  MASTER_FLAGS,
  type MasterEnd,
  type MasterMessage,
} from './pty-master-loop.ts';

/** The slice of a `Worker` the master uses. */
export type MasterWorker = {
  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: MessageEvent<MasterMessage>) => void,
  ): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
};

/** Writes `bytes` from `offset` to the master without blocking; throws an error with an errno `code`. */
export type MasterWrite = DescriptorWrite;

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
   * `hold` is told when the write is waiting only because the child has not read what is already
   * queued (`held`), and when it stops waiting without having finished (`resumed`): progress, or a
   * terminal that hung up, which is then a lost write rather than a held one.
   */
  write(bytes: Uint8Array, hold?: InputHold): Promise<void>;
  /** Keep reading but drop the output, so a terminal that is closing can drain. */
  discard(): void;
  /** End the worker and wait for it; `false` means it did not answer in time and was terminated. */
  stop(): Promise<boolean>;
  /**
   * Stop retrying queued input and drop it, leaving the descriptor open. For a reader thread that
   * never confirmed it stopped: the descriptor stays for process teardown, and nothing may keep
   * writing to it. Queued writes are neither taken nor refused, so the session reports them unknown.
   */
  abandon(): void;
  /** Abandon queued input and close the descriptor. Call once, after a confirmed `stop`. */
  close(): void;
};

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

  /** Record how the thread ended, wake whoever waits for that, and answer a waiting read. */
  const end = (how: Ending): void => {
    if (workerGone) return;
    ending = how;
    workerGone = true;
    onWorkerEnd?.();
    if (waiter !== undefined && queue.length === 0) {
      const waiting = waiter;
      waiter = undefined;
      const result = endResult();
      if (result instanceof Error) waiting.reject(result);
      else waiting.resolve(result);
    }
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
    end(
      message.code === undefined ? { how: message.how } : { how: message.how, code: message.code },
    );
  });
  // A thread that dies, or whose module cannot be loaded, says nothing more: the output ends as a failure.
  for (const type of ['error', 'messageerror'] as const) {
    worker.addEventListener(type, () => end({ how: 'error', code: 'WORKER' }));
  }
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
  const input = createInputWriter({ descriptor, write: writeBytes, isHungUp });

  // ---- ending ----------------------------------------------------------------------------------
  return {
    stream,
    write: (bytes, hold) => input.write(bytes, hold),
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
    abandon: () => {
      closed = true;
      input.abandon();
    },
    close: () => {
      if (closed) return;
      closed = true;
      input.abandon();
      device.close(descriptor);
    },
  };
}
