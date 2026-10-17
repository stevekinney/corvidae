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

type NativeLock = LockOperations;

let native: NativeLock | undefined;

/**
 * `flock(2)` through `bun:ffi`, which Bun's own filesystem API does not expose. The lock belongs to
 * the open file description, so a second descriptor opened on the same file conflicts with the
 * first even inside one process, the kernel drops it when the last descriptor closes or the
 * process dies, and a child process does not inherit it (Bun opens descriptors close-on-exec).
 */
function loadNativeLock(): NativeLock {
  if (native !== undefined) return native;
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new BungalowUnsupportedError(
      `Bungalow needs flock(2) and supports macOS and Linux, not ${platform}.`,
    );
  }
  const flockDefinition = { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
  const errnoDefinition = { args: [], returns: FFIType.ptr } as const;
  let flock: (descriptor: number, operation: number) => number;
  let errnoLocation: () => Parameters<typeof read.i32>[0] | null;
  try {
    if (platform === 'darwin') {
      const { symbols } = dlopen('libSystem.B.dylib', {
        flock: flockDefinition,
        __error: errnoDefinition,
      });
      flock = symbols.flock;
      errnoLocation = symbols['__error'];
    } else {
      const { symbols } = dlopen('libc.so.6', {
        flock: flockDefinition,
        __errno_location: errnoDefinition,
      });
      flock = symbols.flock;
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
  };
  return native;
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

/**
 * A holder takes the kernel lock and only then writes its identifier, so a contender that loses
 * can find the file empty or still naming the previous holder. Reading a few times closes most of
 * that window; the identifier is advisory either way.
 */
function readHolderAfterContention(lockPath: string): number | undefined {
  let holder = readHolder(lockPath);
  for (let attempt = 1; holder === undefined && attempt < HOLDER_READ_ATTEMPTS; attempt += 1) {
    Bun.sleepSync(HOLDER_READ_INTERVAL_MILLISECONDS);
    holder = readHolder(lockPath);
  }
  return holder;
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
  operations: LockOperations = loadNativeLock(),
): RootLock {
  const lockPath = join(root, LOCK_FILE);
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, constants.O_RDWR | constants.O_CREAT, 0o600);
  } catch (error) {
    return wrap('open the lock file', error);
  }

  try {
    const attempt = operations.tryLock(descriptor);
    if (attempt === 'contended') {
      throw new BungalowLockedError(root, readHolderAfterContention(lockPath));
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

  return {
    release() {
      try {
        // Leave no identifier behind, so a contender never names a holder that has gone. A crash
        // cannot do this, and the next holder overwrites what the crash left.
        try {
          ftruncateSync(descriptor, 0);
        } catch {
          // Closing the descriptor is what releases the lock; the truncation is a courtesy.
        }
        closeSync(descriptor);
      } catch (error) {
        // A repeat of a close that already took effect.
        if (errorCode(error) !== 'EBADF') wrap('release the lock file', error);
      }
    },
  };
}
