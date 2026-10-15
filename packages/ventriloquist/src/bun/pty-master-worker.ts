import { FFIType, dlopen, ptr } from 'bun:ffi';
import { readSync } from 'node:fs';

import {
  MASTER_FLAG_COUNT,
  runMasterLoop,
  type MasterMessage,
  type MasterPrimitives,
} from './pty-master-loop.ts';

declare const self: Worker;

const POLLIN = 0x1;

/** The worker thread that owns the read side of one PTY master; see `pty-master.ts`. */
self.onmessage = (event: MessageEvent<{ fd: number; shared: SharedArrayBuffer }>) => {
  const { fd, shared } = event.data;
  const { poll } = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
    poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  }).symbols;
  // struct pollfd { int fd; short events; short revents; }
  const pollfd = new Int32Array(2);
  const view = new DataView(pollfd.buffer);
  view.setInt32(0, fd, true);
  view.setInt16(4, POLLIN, true);
  const primitives: MasterPrimitives = {
    // Any event, including a hang-up, means a read will say what happened.
    poll: (timeoutMilliseconds) => poll(ptr(pollfd), 1n, timeoutMilliseconds) > 0,
    read: (buffer, offset, length) => readSync(fd, buffer, offset, length, null),
    wait: (flags, index, expected, timeoutMilliseconds) => {
      Atomics.wait(flags, index, expected, timeoutMilliseconds);
    },
    post: (message: MasterMessage, transfer) => {
      self.postMessage(message, transfer ?? []);
    },
  };
  runMasterLoop(new Int32Array(shared, 0, MASTER_FLAG_COUNT), primitives);
};
