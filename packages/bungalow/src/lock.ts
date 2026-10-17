import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { errorCode } from './error-code.ts';
import { BungalowFilesystemError, BungalowLockedError } from './errors.ts';

const LOCK_FILE = 'lock';
const MAXIMUM_RECLAIM_ATTEMPTS = 8;

/** Whether a process with this identifier exists. A process we may not signal still exists. */
function isProcessAlive(processIdentifier: number): boolean {
  try {
    process.kill(processIdentifier, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove: either way there is nothing further to do.
  }
}

/** The raw lock file text, or `undefined` when the lock is absent. */
function readLockText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function parseHolder(text: string): number | undefined {
  const holder = /^(\d+)\n?$/.exec(text)?.[1];
  if (holder === undefined) return undefined;
  const processIdentifier = Number(holder);
  return Number.isSafeInteger(processIdentifier) && processIdentifier > 0
    ? processIdentifier
    : undefined;
}

export type RootLock = { release(): void };

/**
 * Take the root's single-instance lock. The lock file holds the holder's process identifier.
 *
 * The file is created by hard-linking a fully written temporary file, so creation is atomic and a
 * reader never sees a half-written lock. When the file exists and its holder process is gone (or
 * the text is not an identifier, which only corruption produces), the stale lock is renamed away
 * and creation is retried. After the rename the text is read again: if it is no longer the stale
 * text, a live holder won a race between our read and our rename, and that lock is linked back.
 * A process identifier that the operating system has since reused for an unrelated process reads
 * as alive, so a stale lock can outlast its holder; the error names the identifier so the lock can
 * be removed by hand.
 */
export function acquireRootLock(root: string): RootLock {
  const lockPath = join(root, LOCK_FILE);
  const ownText = `${process.pid}\n`;
  const suffix = `${process.pid}-${crypto.randomUUID()}`;
  const ownTemporary = join(root, `.lock-${suffix}`);
  const staleTemporary = join(root, `.lock-stale-${suffix}`);

  try {
    writeFileSync(ownTemporary, ownText, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new BungalowFilesystemError('Could not prepare the lock file.', { cause: error });
  }

  try {
    for (let attempt = 0; attempt < MAXIMUM_RECLAIM_ATTEMPTS; attempt += 1) {
      try {
        linkSync(ownTemporary, lockPath);
        return { release: () => releaseRootLock(lockPath, ownText) };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw new BungalowFilesystemError('Could not create the lock file.', { cause: error });
        }
      }

      const observed = readLockText(lockPath);
      if (observed === undefined) continue;
      const holder = parseHolder(observed);
      if (holder !== undefined && isProcessAlive(holder)) {
        throw new BungalowLockedError(root, holder);
      }

      try {
        renameSync(lockPath, staleTemporary);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw new BungalowFilesystemError('Could not reclaim the stale lock file.', {
          cause: error,
        });
      }
      const removed = readLockText(staleTemporary);
      if (removed !== undefined && removed !== observed) {
        // We displaced a lock that was taken after we read it. Link it back, which is atomic and
        // fails if another process has since taken the lock, and report its holder.
        try {
          linkSync(staleTemporary, lockPath);
        } catch {
          // Another process already took the lock; the next attempt reports it.
        }
        unlinkQuietly(staleTemporary);
        const winner = parseHolder(removed);
        if (winner !== undefined && isProcessAlive(winner)) {
          throw new BungalowLockedError(root, winner);
        }
        continue;
      }
      unlinkQuietly(staleTemporary);
    }
    const lastObserved = readLockText(lockPath);
    const holder = lastObserved === undefined ? undefined : parseHolder(lastObserved);
    if (holder !== undefined) throw new BungalowLockedError(root, holder);
    throw new BungalowFilesystemError('Could not acquire the lock file after repeated attempts.');
  } finally {
    unlinkQuietly(ownTemporary);
  }
}

/** Remove the lock only if it still names this process, so a reclaimed lock is never deleted. */
function releaseRootLock(lockPath: string, ownText: string): void {
  try {
    if (readLockText(lockPath) === ownText) unlinkSync(lockPath);
  } catch (error) {
    throw new BungalowFilesystemError('Could not release the lock file.', { cause: error });
  }
}
