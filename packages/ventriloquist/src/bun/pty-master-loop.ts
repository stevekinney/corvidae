/**
 * The read loop that runs on the worker thread owning a PTY master, written against injected
 * primitives so it can be driven in-process. Reading stops, and so the kernel's terminal buffer
 * fills and blocks the producer, whenever the main thread has not taken what was already posted.
 */

/** Most output the worker posts ahead of what the main thread has taken. */
export const MASTER_WINDOW_BYTES = 256 * 1024;

/** The most one message carries. macOS returns 1,024 bytes per read, so a message is many reads. */
export const MASTER_CHUNK_BYTES = 64 * 1024;

/** How long the worker waits before it looks at the stop flag again. */
export const MASTER_POLL_MILLISECONDS = 50;

/** Indexes into the shared `Int32Array` both threads use. */
export const MASTER_FLAGS = {
  /** Set by the main thread: end the loop. */
  stop: 0,
  /** Set by the main thread: read and drop, so a terminal being closed can drain. */
  discard: 1,
  /** Bytes posted and not yet taken by the main thread; the worker waits while this is at the window. */
  inflight: 2,
} as const;

export const MASTER_FLAG_COUNT = 3;

/** Why the loop ended. `eof` is the macOS end of output, `eio` the Linux one. */
export type MasterEnd = 'eof' | 'eio' | 'stopped' | 'error';

export type MasterMessage =
  | { readonly type: 'data'; readonly chunk: ArrayBuffer }
  | { readonly type: 'end'; readonly how: MasterEnd; readonly code?: string };

export type MasterPrimitives = {
  /** Wait up to `timeoutMilliseconds` for the master to be readable or hung up; `false` on timeout. */
  poll(timeoutMilliseconds: number): boolean;
  /** Read without blocking into `buffer`; throws an error with an errno `code` (`EAGAIN` when nothing is there). */
  read(buffer: Uint8Array, offset: number, length: number): number;
  /** Sleep while `flags[index]` equals `expected`, or until the timeout. */
  wait(flags: Int32Array, index: number, expected: number, timeoutMilliseconds: number): void;
  post(message: MasterMessage, transfer?: ArrayBuffer[]): void;
};

type ReadOutcome =
  | { readonly kind: 'bytes'; readonly count: number }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ended'; readonly how: MasterEnd; readonly code?: string };

function readOnce(io: MasterPrimitives, buffer: Uint8Array, offset: number): ReadOutcome {
  try {
    const count = io.read(buffer, offset, buffer.length - offset);
    return count === 0 ? { kind: 'ended', how: 'eof' } : { kind: 'bytes', count };
  } catch (error) {
    const code = (error as { readonly code?: string }).code;
    if (code === 'EAGAIN') return { kind: 'empty' };
    if (code === 'EIO') return { kind: 'ended', how: 'eio', code };
    return { kind: 'ended', how: 'error', code: code ?? 'UNKNOWN' };
  }
}

/** Run until the master ends or `flags[stop]` is set; posts every chunk and exactly one `end`. */
export function runMasterLoop(flags: Int32Array, io: MasterPrimitives): void {
  const scratch = new Uint8Array(MASTER_CHUNK_BYTES);
  let ended: Extract<ReadOutcome, { kind: 'ended' }> | undefined;
  while (ended === undefined && Atomics.load(flags, MASTER_FLAGS.stop) === 0) {
    const discarding = Atomics.load(flags, MASTER_FLAGS.discard) === 1;
    const inflight = Atomics.load(flags, MASTER_FLAGS.inflight);
    if (!discarding && inflight >= MASTER_WINDOW_BYTES) {
      // Not reading is the pause: the producer blocks once the terminal's own buffer is full.
      io.wait(flags, MASTER_FLAGS.inflight, inflight, MASTER_POLL_MILLISECONDS);
      continue;
    }
    if (!io.poll(MASTER_POLL_MILLISECONDS)) continue;
    let filled = 0;
    // Drain what is there without blocking, so one message carries many kernel-sized reads.
    while (ended === undefined && filled < MASTER_CHUNK_BYTES) {
      const outcome = readOnce(io, scratch, filled);
      if (outcome.kind === 'empty') break;
      if (outcome.kind === 'ended') ended = outcome;
      else filled += outcome.count;
      if (discarding) filled = 0;
    }
    if (filled > 0) {
      Atomics.add(flags, MASTER_FLAGS.inflight, filled);
      const chunk = scratch.buffer.slice(0, filled);
      io.post({ type: 'data', chunk }, [chunk]);
    }
  }
  io.post(
    ended === undefined
      ? { type: 'end', how: 'stopped' }
      : { type: 'end', how: ended.how, ...(ended.code === undefined ? {} : { code: ended.code }) },
  );
}
