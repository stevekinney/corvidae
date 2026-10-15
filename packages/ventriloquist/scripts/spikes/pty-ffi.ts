/* oxlint-disable -- COR-1522 throwaway spike: measures behavior, is not production code, and is deleted or promoted by the implementation. */
/**
 * Own a pseudo-terminal pair from libc through `bun:ffi`, so the host holds the master descriptor
 * and decides when to read it. Throwaway-quality spike code.
 */
import { cc, CString, dlopen, FFIType } from 'bun:ffi';
import { closeSync, constants, openSync } from 'node:fs';

const libraryPath = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6';

const libc = dlopen(libraryPath, {
  posix_openpt: { args: [FFIType.i32], returns: FFIType.i32 },
  grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
  unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
  ptsname: { args: [FFIType.i32], returns: FFIType.ptr },
  tcgetpgrp: { args: [FFIType.i32], returns: FFIType.i32 },
});

// ioctl is variadic; a plain FFI call to it is wrong on Apple arm64 (it returned success and changed
// nothing), so a fixed-arity C wrapper is compiled at runtime.
const winsize = cc({
  source: new URL('./winsize.c', import.meta.url).pathname,
  symbols: {
    set_winsize: { args: ['int', 'u64', 'int', 'int'], returns: 'int' },
    get_flags: { args: ['int'], returns: 'int' },
    set_flags: { args: ['int', 'int'], returns: 'int' },
    set_cloexec: { args: ['int'], returns: 'int' },
  },
});

const O_RDWR = constants.O_RDWR;
const O_NOCTTY = constants.O_NOCTTY;
const O_NONBLOCK = constants.O_NONBLOCK;
// TIOCSWINSZ differs by platform: BSD encodes it with _IOW; Linux has a fixed number.
const TIOCSWINSZ = process.platform === 'darwin' ? 0x80087467n : 0x5414n;

export type PtyPair = {
  /** The master descriptor. `posix_openpt` does not set close-on-exec, so `openPty` sets it explicitly. */
  masterFd: number;
  /** The path of the slave device, e.g. /dev/ttys012 or /dev/pts/3. */
  slavePath: string;
};

export function openPty(): PtyPair {
  const masterFd = libc.symbols.posix_openpt(O_RDWR | O_NOCTTY);
  if (masterFd < 0) throw new Error('posix_openpt failed');
  if (libc.symbols.grantpt(masterFd) !== 0) throw new Error('grantpt failed');
  if (libc.symbols.unlockpt(masterFd) !== 0) throw new Error('unlockpt failed');
  const name = libc.symbols.ptsname(masterFd);
  if (name === null) throw new Error('ptsname failed');
  const slavePath = new CString(name).toString();
  // Bun closes non-stdio descriptors in a spawned child (observed on macOS and Linux), but that is
  // not something to depend on: a child holding another session's master would keep it alive.
  winsize.symbols.set_cloexec(masterFd);
  return { masterFd, slavePath };
}

/**
 * TIOCSWINSZ on the master. Returns the ioctl result (0 on success). On macOS this fails with ENOTTY
 * until the slave has been opened, so call it after `openSlaveNoCtty`.
 */
export function setWindowSize(pair: PtyPair, columns: number, rows: number): number {
  return winsize.symbols.set_winsize(pair.masterFd, Number(TIOCSWINSZ), columns, rows);
}

/**
 * fcntl is variadic too: calling it through plain FFI on Apple arm64 silently did nothing (reads
 * on the "nonblocking" master still blocked), so it goes through the compiled wrapper.
 */
export function setNonBlocking(fd: number): void {
  winsize.symbols.set_flags(fd, winsize.symbols.get_flags(fd) | O_NONBLOCK);
}

export function isNonBlocking(fd: number): boolean {
  return (winsize.symbols.get_flags(fd) & O_NONBLOCK) !== 0;
}

export function foregroundGroup(masterFd: number): number {
  return libc.symbols.tcgetpgrp(masterFd);
}

/** Open the slave the way a session leader does, to keep the device alive while the host holds it. */
export function openSlaveNoCtty(path: string): number {
  return openSync(path, O_RDWR | O_NOCTTY);
}

export function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // closed
  }
}
