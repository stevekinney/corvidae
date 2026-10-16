import { CString, FFIType, cc, dlopen } from 'bun:ffi';
import { closeSync, constants, openSync } from 'node:fs';

/** The two ends of a pseudo-terminal this process opened: the master it reads and writes, and the slave's path. */
export type PtyPair = {
  readonly masterFd: number;
  readonly slavePath: string;
};

/**
 * The operating-system calls the PTY host makes, behind one seam so a test can describe a device
 * that fails where a real one cannot be made to. Each call either succeeds or throws; none of
 * them leaves a descriptor open on failure.
 */
export type PtyDevice = {
  /** A new master/slave pair: close-on-exec, non-blocking master, slave not yet opened. */
  open(): PtyPair;
  /** Open the slave for the child's standard streams, without taking it as this process's controlling terminal. */
  openSlave(path: string): number;
  /** Set the window size. macOS refuses until the slave has been opened once, so call this after `openSlave`. */
  setWindowSize(pair: PtyPair, columns: number, rows: number): void;
  /** Close a descriptor; one that is already closed is not an error. */
  close(descriptor: number): void;
};

/** The libc calls and C wrappers a device is made of, so a test can make any one of them fail. */
export type LibcBindings = {
  posix_openpt(flags: number): number;
  grantpt(descriptor: number): number;
  unlockpt(descriptor: number): number;
  /** The slave's path, or `null` when libc has none. */
  ptsname(descriptor: number): string | null;
  setWindowSize(descriptor: number, request: number, columns: number, rows: number): number;
  getFlags(descriptor: number): number;
  setFlags(descriptor: number, flags: number): number;
  setCloseOnExec(descriptor: number): number;
};

/** BSD encodes TIOCSWINSZ with _IOW; Linux has a fixed number. */
export const TIOCSWINSZ: Readonly<Record<'darwin' | 'linux', number>> = {
  darwin: 0x80087467,
  linux: 0x5414,
};

/** Build the device over `libc`. Everything platform specific is a parameter, so it can be driven anywhere. */
export function createPtyDevice(
  libc: LibcBindings,
  windowSizeRequest: number,
  files: {
    readonly open: (path: string, flags: number) => number;
    readonly close: (descriptor: number) => void;
  },
): PtyDevice {
  const close = (descriptor: number): void => {
    try {
      files.close(descriptor);
    } catch {
      // Already closed.
    }
  };
  return {
    open: () => {
      const masterFd = libc.posix_openpt(constants.O_RDWR | constants.O_NOCTTY);
      if (masterFd < 0) throw new Error('posix_openpt failed');
      try {
        if (libc.grantpt(masterFd) !== 0) throw new Error('grantpt failed');
        if (libc.unlockpt(masterFd) !== 0) throw new Error('unlockpt failed');
        const slavePath = libc.ptsname(masterFd);
        if (slavePath === null) throw new Error('ptsname failed');
        // Bun closes descriptors it was not asked to pass on, but the master must not depend on that:
        // a child holding another session's master would keep that session's terminal alive.
        if (libc.setCloseOnExec(masterFd) !== 0) throw new Error('FD_CLOEXEC failed');
        const flags = libc.getFlags(masterFd);
        if (flags < 0 || libc.setFlags(masterFd, flags | constants.O_NONBLOCK) !== 0) {
          throw new Error('O_NONBLOCK failed');
        }
        return { masterFd, slavePath };
      } catch (error) {
        close(masterFd);
        throw error;
      }
    },
    openSlave: (path) => files.open(path, constants.O_RDWR | constants.O_NOCTTY),
    setWindowSize: (pair, columns, rows) => {
      if (libc.setWindowSize(pair.masterFd, windowSizeRequest, columns, rows) !== 0) {
        throw new Error('TIOCSWINSZ failed');
      }
    },
    close,
  };
}

/** The compiled fixed-arity wrappers over `fcntl` and `ioctl`, shared by every device that needs them. */
export type DescriptorWrappers = {
  pty_set_window_size: (
    descriptor: number,
    request: number,
    columns: number,
    rows: number,
  ) => number;
  pty_get_flags: (descriptor: number) => number;
  pty_set_flags: (descriptor: number, flags: number) => number;
  pty_set_close_on_exec: (descriptor: number) => number;
};

let wrappers: DescriptorWrappers | undefined;

/**
 * `ioctl` and `fcntl` are variadic: see pty-helpers.c for why they are not bound directly. Compiled
 * once and shared, because a pipe's input end needs the same flag calls as a terminal's master.
 */
export function loadDescriptorWrappers(): DescriptorWrappers {
  wrappers ??= cc({
    source: new URL('./pty-helpers.c', import.meta.url),
    symbols: {
      pty_set_window_size: { args: ['int', 'u64', 'int', 'int'], returns: 'int' },
      pty_get_flags: { args: ['int'], returns: 'int' },
      pty_set_flags: { args: ['int', 'int'], returns: 'int' },
      pty_set_close_on_exec: { args: ['int'], returns: 'int' },
    },
  }).symbols as DescriptorWrappers;
  return wrappers;
}

let device: PtyDevice | undefined;

/**
 * Bind libc and compile the variadic wrappers. Throws when this host cannot: a libc that is not
 * glibc or libSystem, or a Bun without the C compiler. The host maps that to `unsupported-runtime`.
 */
export function loadPtyDevice(): PtyDevice {
  if (device !== undefined) return device;
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const libc = dlopen(platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
    posix_openpt: { args: [FFIType.i32], returns: FFIType.i32 },
    grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
    unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
    ptsname: { args: [FFIType.i32], returns: FFIType.ptr },
  }).symbols;
  const flags = loadDescriptorWrappers();
  device = createPtyDevice(
    {
      posix_openpt: libc.posix_openpt,
      grantpt: libc.grantpt,
      unlockpt: libc.unlockpt,
      ptsname: (descriptor) => {
        const name = libc.ptsname(descriptor);
        return name === null ? null : new CString(name).valueOf();
      },
      setWindowSize: flags.pty_set_window_size,
      getFlags: flags.pty_get_flags,
      setFlags: flags.pty_set_flags,
      setCloseOnExec: flags.pty_set_close_on_exec,
    },
    TIOCSWINSZ[platform],
    { open: openSync, close: closeSync },
  );
  return device;
}
