import { FFIType, dlopen, ptr } from 'bun:ffi';
import { closeSync, constants } from 'node:fs';

import { loadDescriptorWrappers } from './pty-device.ts';

/** The two ends of a pipe: the end the child reads as its standard input, and the end this process writes. */
export type PipePair = {
  readonly readFd: number;
  readonly writeFd: number;
};

/**
 * The operating-system calls a pipe's input makes, behind one seam so a test can describe a device
 * that fails where a real one cannot be made to. Bun's own stdin sink is not used because it buffers
 * without a bound the session can see, so a child that never reads would hold half a mebibyte; with
 * the descriptor in hand the kernel's pipe buffer is the only buffer.
 */
export type PipeDevice = {
  /** A new pipe: both ends close-on-exec, the write end non-blocking. */
  open(): PipePair;
  /** Close a descriptor; one that is already closed is not an error. */
  close(descriptor: number): void;
};

export type PipeLibc = {
  /** Fills `descriptors` with the read end then the write end; returns 0 on success. */
  pipe(descriptors: Int32Array): number;
  getFlags(descriptor: number): number;
  setFlags(descriptor: number, flags: number): number;
  setCloseOnExec(descriptor: number): number;
};

export function createPipeDevice(
  libc: PipeLibc,
  files: { readonly close: (descriptor: number) => void },
): PipeDevice {
  const close = (descriptor: number): void => {
    try {
      files.close(descriptor);
    } catch {
      // Already closed.
    }
  };
  return {
    open: () => {
      const descriptors = new Int32Array(2);
      if (libc.pipe(descriptors) !== 0) throw new Error('pipe failed');
      const readFd = descriptors[0] as number;
      const writeFd = descriptors[1] as number;
      try {
        // Neither end may leak into another child: a holder of the write end would keep this child's
        // input from ever reaching end of file.
        if (libc.setCloseOnExec(readFd) !== 0 || libc.setCloseOnExec(writeFd) !== 0) {
          throw new Error('FD_CLOEXEC failed');
        }
        const flags = libc.getFlags(writeFd);
        if (flags < 0 || libc.setFlags(writeFd, flags | constants.O_NONBLOCK) !== 0) {
          throw new Error('O_NONBLOCK failed');
        }
        return { readFd, writeFd };
      } catch (error) {
        close(readFd);
        close(writeFd);
        throw error;
      }
    },
    close,
  };
}

let device: PipeDevice | undefined;

/** Bind libc and the shared flag wrappers. Throws when this host cannot. */
export function loadPipeDevice(): PipeDevice {
  if (device !== undefined) return device;
  const libc = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
    pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  const flags = loadDescriptorWrappers();
  device = createPipeDevice(
    {
      pipe: (descriptors) => libc.pipe(ptr(descriptors)),
      getFlags: flags.pty_get_flags,
      setFlags: flags.pty_set_flags,
      setCloseOnExec: flags.pty_set_close_on_exec,
    },
    { close: closeSync },
  );
  return device;
}
