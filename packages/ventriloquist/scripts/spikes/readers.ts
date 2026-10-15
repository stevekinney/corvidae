/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Candidate readers: each turns a descriptor (or Bun subprocess pipe) into a pausable source.
 * `pause()` must stop the host from pulling bytes out of the kernel; `resume()` starts again.
 */
import { createReadStream } from 'node:fs';
import { Socket } from 'node:net';
import { ReadStream as TtyReadStream } from 'node:tty';

export type PausableReader = {
  name: string;
  pause(): void;
  resume(): void;
  /** Resolves when the source ended (EOF or the platform's EIO equivalent) or errored. */
  done: Promise<{ ok: boolean; error?: string }>;
  close(): void;
};

type Listener = (chunk: Uint8Array) => void;

function fromNodeStream(
  name: string,
  stream: NodeJS.ReadableStream & { destroy(): unknown; pause(): unknown; resume(): unknown },
  onData: Listener,
): PausableReader {
  const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    let settled = false;
    const finish = (value: { ok: boolean; error?: string }): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    stream.on('end', () => finish({ ok: true }));
    stream.on('close', () => finish({ ok: true }));
    stream.on('error', (error: NodeJS.ErrnoException) => {
      // Linux reports the end of a pseudo-terminal master as EIO.
      finish({ ok: error.code === 'EIO', error: error.code ?? String(error) });
    });
  });
  stream.on('data', (chunk: Uint8Array) => onData(chunk));
  stream.pause();
  return {
    name,
    pause: () => void stream.pause(),
    resume: () => void stream.resume(),
    done,
    close: () => void stream.destroy(),
  };
}

export function fsReadStreamReader(
  fd: number,
  onData: Listener,
  highWaterMark = 64 * 1024,
): PausableReader {
  const stream = createReadStream('', { fd, autoClose: false, highWaterMark });
  return fromNodeStream('fs.createReadStream', stream as never, onData);
}

export function netSocketReader(
  fd: number,
  onData: Listener,
  highWaterMark = 64 * 1024,
): PausableReader {
  const socket = new Socket({ fd, readable: true, writable: true, highWaterMark } as never);
  return fromNodeStream('net.Socket', socket as never, onData);
}

export function ttyReadStreamReader(fd: number, onData: Listener): PausableReader {
  const stream = new TtyReadStream(fd);
  return fromNodeStream('tty.ReadStream', stream as never, onData);
}

/** A pull loop over a WHATWG byte stream: pausing simply stops calling read(). */
export function pullReader(
  name: string,
  stream: ReadableStream<Uint8Array>,
  onData: Listener,
): PausableReader {
  const reader = stream.getReader();
  let paused = true;
  let wake: (() => void) | undefined;
  let closed = false;
  const done = (async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      for (;;) {
        while (paused && !closed) await new Promise<void>((resolve) => (wake = resolve));
        if (closed) return { ok: true };
        const result = await reader.read();
        if (result.done) return { ok: true };
        onData(result.value);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { ok: code === 'EIO', error: code ?? String(error) };
    }
  })();
  return {
    name,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      wake?.();
    },
    done,
    close: () => {
      closed = true;
      wake?.();
      void reader.cancel().catch(() => undefined);
    },
  };
}

import { readSync } from 'node:fs';

/**
 * Main-thread drain loop over a nonblocking descriptor: read until EAGAIN, then wait on a timer
 * that backs off while idle. Pausing stops the loop, so nothing is read from the kernel.
 */
export function drainReader(fd: number, onData: Listener): PausableReader {
  let paused = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleMs = 1;
  let finished = false;
  let resolveDone!: (value: { ok: boolean; error?: string }) => void;
  const done = new Promise<{ ok: boolean; error?: string }>((resolve) => (resolveDone = resolve));
  const finish = (value: { ok: boolean; error?: string }): void => {
    if (finished) return;
    finished = true;
    resolveDone(value);
  };
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const tick = (): void => {
    timer = undefined;
    if (paused || finished) return;
    let got = false;
    for (let spins = 0; spins < 64; spins += 1) {
      let count: number;
      try {
        count = readSync(fd, buffer);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EAGAIN') break;
        finish({ ok: code === 'EIO', error: code ?? 'unknown' });
        return;
      }
      if (count === 0) {
        finish({ ok: true });
        return;
      }
      got = true;
      onData(buffer.slice(0, count));
    }
    idleMs = got ? 1 : Math.min(idleMs * 2, 8);
    timer = got && !paused ? (setImmediate(tick) as never) : setTimeout(tick, idleMs);
  };
  return {
    name: 'drain',
    pause: () => {
      paused = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    resume: () => {
      if (!paused) return;
      paused = false;
      idleMs = 1;
      timer ??= setTimeout(tick, 0);
    },
    done,
    close: () => {
      paused = true;
      finish({ ok: true });
    },
  };
}

/** Worker-thread reader with a bounded in-flight window; see pty-reader-worker.ts. */
export function workerReader(fd: number, onData: Listener): PausableReader {
  const shared = new SharedArrayBuffer(12);
  const flags = new Int32Array(shared);
  const worker = new Worker(new URL('./pty-reader-worker.ts', import.meta.url).href);
  let resolveDone!: (value: { ok: boolean; error?: string }) => void;
  const done = new Promise<{ ok: boolean; error?: string }>((resolve) => (resolveDone = resolve));
  Atomics.store(flags, 0, 1); // paused until resume()
  worker.onmessage = (event: MessageEvent<{ type: string; chunk?: ArrayBuffer; how?: string }>) => {
    if (event.data.type === 'data') {
      const chunk = new Uint8Array(event.data.chunk!);
      Atomics.sub(flags, 2, chunk.length);
      Atomics.notify(flags, 2);
      onData(chunk);
    } else {
      resolveDone({ ok: event.data.how !== 'error', error: event.data.how ?? 'unknown' });
      void worker.terminate();
    }
  };
  worker.postMessage({ fd, shared });
  return {
    name: 'worker',
    pause: () => {
      Atomics.store(flags, 0, 1);
    },
    resume: () => {
      Atomics.store(flags, 0, 0);
      Atomics.notify(flags, 0);
    },
    done,
    close: () => {
      Atomics.store(flags, 1, 1);
      Atomics.notify(flags, 0);
    },
  };
}
