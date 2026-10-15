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
  close(descriptor: number): void;
};

// BSD encodes the request with _IOW; Linux has a fixed number.
const TIOCSWINSZ = process.platform === 'darwin' ? 0x80087467 : 0x5414;

let device: PtyDevice | undefined;

/**
 * Bind libc and compile the three variadic wrappers. Throws when this host cannot: a libc that is
 * not glibc or libSystem, or a Bun without the C compiler. The host maps that to `unsupported-runtime`.
 */
export function loadPtyDevice(): PtyDevice {
  if (device !== undefined) return device;
  const libc = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
    posix_openpt: { args: [FFIType.i32], returns: FFIType.i32 },
    grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
    unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
    ptsname: { args: [FFIType.i32], returns: FFIType.ptr },
  }).symbols;
  const wrappers = cc({
    source: new URL('./pty-helpers.c', import.meta.url),
    symbols: {
      pty_set_window_size: { args: ['int', 'u64', 'int', 'int'], returns: 'int' },
      pty_get_flags: { args: ['int'], returns: 'int' },
      pty_set_flags: { args: ['int', 'int'], returns: 'int' },
      pty_set_close_on_exec: { args: ['int'], returns: 'int' },
    },
  }).symbols;
  const close = (descriptor: number): void => {
    try {
      closeSync(descriptor);
    } catch {
      // Already closed.
    }
  };
  device = {
    open: () => {
      const masterFd = libc.posix_openpt(constants.O_RDWR | constants.O_NOCTTY);
      if (masterFd < 0) throw new Error('posix_openpt failed');
      try {
        if (libc.grantpt(masterFd) !== 0) throw new Error('grantpt failed');
        if (libc.unlockpt(masterFd) !== 0) throw new Error('unlockpt failed');
        const name = libc.ptsname(masterFd);
        if (name === null) throw new Error('ptsname failed');
        // Bun closes descriptors it was not asked to pass on, but the master must not depend on that:
        // a child holding another session's master would keep that session's terminal alive.
        if (wrappers.pty_set_close_on_exec(masterFd) !== 0) throw new Error('FD_CLOEXEC failed');
        const flags = wrappers.pty_get_flags(masterFd);
        if (flags < 0 || wrappers.pty_set_flags(masterFd, flags | constants.O_NONBLOCK) !== 0) {
          throw new Error('O_NONBLOCK failed');
        }
        return { masterFd, slavePath: new CString(name).toString() };
      } catch (error) {
        close(masterFd);
        throw error;
      }
    },
    openSlave: (path) => openSync(path, constants.O_RDWR | constants.O_NOCTTY),
    setWindowSize: (pair, columns, rows) => {
      if (wrappers.pty_set_window_size(pair.masterFd, TIOCSWINSZ, columns, rows) !== 0) {
        throw new Error('TIOCSWINSZ failed');
      }
    },
    close,
  };
  return device;
}
