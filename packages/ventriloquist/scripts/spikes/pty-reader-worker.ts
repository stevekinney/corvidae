/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Worker half of the worker reader: owns the read side of a PTY master, with credit-based flow
 * control through a SharedArrayBuffer so reading stops (and the kernel buffer fills) whenever the
 * main thread has not consumed what was already posted, or has paused it.
 *
 * Layout of the shared Int32Array: [0] paused flag, [1] stop flag, [2] bytes posted but not yet
 * consumed by the main thread.
 */
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { readSync } from 'node:fs';

declare const self: Worker;

const libraryPath = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6';
const libc = dlopen(libraryPath, {
  poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
});

const POLLIN = 0x1;
const WINDOW_BYTES = 256 * 1024;
const CHUNK_BYTES = 64 * 1024;

self.onmessage = (event: MessageEvent<{ fd: number; shared: SharedArrayBuffer }>) => {
  const { fd, shared } = event.data;
  const flags = new Int32Array(shared);
  const pollfd = new Int32Array(2); // { int fd; short events; short revents }
  const view = new DataView(pollfd.buffer);
  view.setInt32(0, fd, true);
  view.setInt16(4, POLLIN, true);
  let ended: 'eof' | 'eio' | 'error' | undefined;
  while (Atomics.load(flags, 1) === 0 && ended === undefined) {
    if (Atomics.load(flags, 0) === 1 || Atomics.load(flags, 2) >= WINDOW_BYTES) {
      // Paused, or the main thread is behind: do not touch the kernel buffer. Wake on notify.
      Atomics.wait(flags, 0, Atomics.load(flags, 0), 50);
      if (Atomics.load(flags, 0) === 0 && Atomics.load(flags, 2) >= WINDOW_BYTES)
        Atomics.wait(flags, 2, Atomics.load(flags, 2), 50);
      continue;
    }
    view.setInt16(6, 0, true);
    const ready = libc.symbols.poll(ptr(pollfd), 1n, 50);
    if (ready <= 0) continue; // timeout: look at the flags again
    const buffer = new Uint8Array(CHUNK_BYTES);
    let filled = 0;
    // Drain what is there without blocking, so one message carries many kernel-sized reads.
    while (filled < CHUNK_BYTES) {
      let count: number;
      try {
        count = readSync(fd, buffer, filled, CHUNK_BYTES - filled, null);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EAGAIN') break;
        ended = code === 'EIO' ? 'eio' : 'error';
        break;
      }
      if (count === 0) {
        ended = 'eof';
        break;
      }
      filled += count;
    }
    if (filled > 0) {
      Atomics.add(flags, 2, filled);
      const chunk = buffer.buffer.slice(0, filled);
      self.postMessage({ type: 'data', chunk }, [chunk]);
    }
  }
  self.postMessage({ type: 'end', how: ended ?? 'stopped' });
};
