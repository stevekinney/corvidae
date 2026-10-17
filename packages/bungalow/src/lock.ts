import { dlopen, FFIType, read } from 'bun:ffi';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { errorCode, sanitizeCause } from './error-code.ts';
import {
  BungalowError,
  BungalowFilesystemError,
  BungalowLockedError,
  BungalowUnsupportedError,
} from './errors.ts';

const LOCK_FILE = 'lock';
const LOCK_EXCLUSIVE = 2;
const LOCK_NON_BLOCKING = 4;
/** `EWOULDBLOCK`, which is `EAGAIN`: 35 on macOS, 11 on Linux. */
const WOULD_BLOCK = { darwin: 35, linux: 11 } as const;
const HOLDER_READ_ATTEMPTS = 50;
const HOLDER_READ_INTERVAL_MILLISECONDS = 10;

/** What asking the kernel for the lock came to. */
export type LockAttempt = 'acquired' | 'contended' | { readonly errno: number };

/** The calls the lock makes, behind one seam so a test can describe a host that fails them. */
export type LockOperations = {
  tryLock(descriptor: number): LockAttempt;
};

/** The platform's `O_CLOEXEC`, which Node's `constants` leaves undefined on macOS. */
const CLOSE_ON_EXEC_FLAG = { darwin: 0x01000000, linux: 0x80000 } as const;
const GET_DESCRIPTOR_FLAGS = 1;
const CLOSE_ON_EXEC = 1;

/** The real calls. `isCloseOnExec` is for tests that check how a descriptor was opened. */
export type NativeLock = LockOperations & {
  isCloseOnExec(descriptor: number): boolean;
};

let native: NativeLock | undefined;

/**
 * `flock(2)` through `bun:ffi`, which Bun's own filesystem API does not expose. The lock belongs to
 * the open file description, so a second descriptor opened on the same file conflicts with the
 * first even inside one process, and the kernel drops it when the last descriptor closes or the
 * process dies. The lock file is opened with `O_CLOEXEC` so that no child this process execs can
 * hold the lock past it; Node and Bun do not set it on a plain `open`.
 *
 * `fcntl` is variadic, and a plain FFI call to it does nothing on Apple arm64, so the flag is set
 * at `open` rather than with `F_SETFD`. `F_GETFD` takes no third argument and reads correctly.
 */
export function systemLockOperations(): NativeLock {
  if (native !== undefined) return native;
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new BungalowUnsupportedError(
      `Bungalow needs flock(2) and supports macOS and Linux, not ${platform}.`,
    );
  }
  const flockDefinition = { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
  const fcntlDefinition = {
    args: [FFIType.i32, FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  } as const;
  const errnoDefinition = { args: [], returns: FFIType.ptr } as const;
  let flock: (descriptor: number, operation: number) => number;
  let fcntl: (descriptor: number, command: number, argument: number) => number;
  let errnoLocation: () => Parameters<typeof read.i32>[0] | null;
  try {
    if (platform === 'darwin') {
      const { symbols } = dlopen('libSystem.B.dylib', {
        flock: flockDefinition,
        fcntl: fcntlDefinition,
        __error: errnoDefinition,
      });
      flock = symbols.flock;
      fcntl = symbols.fcntl;
      errnoLocation = symbols['__error'];
    } else {
      const { symbols } = dlopen('libc.so.6', {
        flock: flockDefinition,
        fcntl: fcntlDefinition,
        __errno_location: errnoDefinition,
      });
      flock = symbols.flock;
      fcntl = symbols.fcntl;
      errnoLocation = symbols['__errno_location'];
    }
  } catch (error) {
    throw new BungalowUnsupportedError('Bungalow could not load the C library for flock(2).', {
      cause: sanitizeCause(error),
    });
  }
  native = {
    tryLock(descriptor) {
      if (flock(descriptor, LOCK_EXCLUSIVE | LOCK_NON_BLOCKING) === 0) return 'acquired';
      const location = errnoLocation();
      const errno = location === null ? -1 : read.i32(location);
      return errno === WOULD_BLOCK[platform] ? 'contended' : { errno };
    },
    isCloseOnExec(descriptor) {
      return (fcntl(descriptor, GET_DESCRIPTOR_FLAGS, 0) & CLOSE_ON_EXEC) !== 0;
    },
  };
  return native;
}

function openFlags(): number {
  const platform = process.platform;
  const closeOnExec =
    platform === 'darwin' || platform === 'linux' ? CLOSE_ON_EXEC_FLAG[platform] : 0;
  return constants.O_RDWR | constants.O_CREAT | closeOnExec;
}

function wrap(description: string, error: unknown): never {
  if (error instanceof BungalowError) throw error;
  throw new BungalowFilesystemError(`Could not ${description}.`, {
    cause: sanitizeCause(error),
  });
}

/** The process identifier on the first line of the lock file, if it holds one. */
function readHolder(lockPath: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    return wrap('read the lock file', error);
  }
  const firstLine = text.split('\n', 1)[0] ?? '';
  if (!/^\d+$/.test(firstLine)) return undefined;
  const holder = Number(firstLine);
  return Number.isSafeInteger(holder) && holder > 0 ? holder : undefined;
}

export type RootLock = { release(): void };

/**
 * Take the root's single-instance lock: an exclusive, non-blocking `flock` on `<root>/lock`.
 *
 * The kernel is the arbiter. There is no lock protocol to race: two openers, in one process or
 * many, cannot both hold it, and a holder that dies without closing loses it at once, so a stale
 * lock cannot exist and there is nothing to reclaim. The file is never removed. The holder writes
 * its process identifier as the first line after taking the lock, and a contender reads only that
 * line, so a later version may add more.
 *
 * Whole-file `flock` needs a filesystem that supports it: a local one on macOS or Linux.
 */
export function acquireRootLock(
  root: string,
  operations: LockOperations = systemLockOperations(),
): RootLock {
  const lockPath = join(root, LOCK_FILE);
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, openFlags(), 0o600);
  } catch (error) {
    return wrap('open the lock file', error);
  }

  try {
    let attempt = operations.tryLock(descriptor);
    // A holder takes the kernel lock before it writes its identifier and clears the file before it
    // releases the lock. A contender can therefore find the file empty because the holder is just
    // starting or just finishing: poll, and take the lock if the holder goes. A readable
    // identifier means the lock was held a moment ago, and that is reported.
    for (let polls = 0; attempt === 'contended'; polls += 1) {
      const holder = readHolder(lockPath);
      if (holder !== undefined || polls >= HOLDER_READ_ATTEMPTS) {
        throw new BungalowLockedError(root, holder);
      }
      Bun.sleepSync(HOLDER_READ_INTERVAL_MILLISECONDS);
      attempt = operations.tryLock(descriptor);
    }
    if (attempt !== 'acquired') {
      throw new BungalowFilesystemError('Could not lock the lock file.', {
        cause: { errno: attempt.errno },
      });
    }
    try {
      if ((fstatSync(descriptor).mode & 0o077) !== 0) fchmodSync(descriptor, 0o600);
      ftruncateSync(descriptor, 0);
      const text = Buffer.from(`${process.pid}\n`);
      writeSync(descriptor, text, 0, text.length, 0);
    } catch (error) {
      return wrap('record the lock holder', error);
    }
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // The attempt already failed; its error is the one worth reporting.
    }
    throw error;
  }

  // The descriptor work happens at most once: once it has begun, the number may name something
  // else (the process reuses descriptor numbers at once), so a retried release must not touch it.
  let consumed = false;
  return {
    release() {
      if (consumed) return;
      consumed = true;
      // Leave no identifier behind, so a contender never names a holder that has gone. A crash
      // cannot do this, and the next holder overwrites what the crash left.
      try {
        ftruncateSync(descriptor, 0);
      } catch {
        // Closing the descriptor is what releases the lock; the truncation is a courtesy.
      }
      try {
        closeSync(descriptor);
      } catch (error) {
        wrap('release the lock file', error);
      }
    },
  };
}
