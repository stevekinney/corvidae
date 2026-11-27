import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { processStartTime } from './process-identity.ts';

export const ownerFileName = 'owner.json';

export type HostLockHolder = {
  readonly pid: number;
  /** `ps -o lstart` for `pid`, so a recycled pid is not mistaken for the holder. */
  readonly pidStartedAt?: string;
  /** The command's process group, recorded once it starts; it can outlive a killed wrapper. */
  readonly processGroup?: number;
  /** `ps -o lstart` for the group's leader when the group started. */
  readonly processGroupStartedAt?: string;
  readonly command: string;
  readonly cwd: string;
  readonly acquiredAt: string;
};

export type OwnerRecord = HostLockHolder & { readonly token: string };

export type HeldHostLock = {
  /** Identifies this lock in its owner file; nested stages present it to reuse the lock. */
  readonly token: string;
  /** Records the command's process group, so the lock outlives a wrapper killed before it. */
  readonly recordProcessGroup: (processGroup: number) => Promise<void>;
  readonly release: () => Promise<void>;
};

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** The entry's status, or undefined when it does not exist; any other failure is thrown. */
export async function statIfPresent(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * A missing file (or a path through a file where a directory belongs, which garbage in a pool
 * leaves), or one caught half written: the only reads a record reader treats as absent.
 */
export function isAbsentOrPartial(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR' || error instanceof SyntaxError;
}

export async function readOwner(lockDirectory: string): Promise<OwnerRecord | undefined> {
  try {
    return JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8')) as OwnerRecord;
  } catch (error) {
    // Missing or half written: an ownerless lock, which callers judge by its age after a grace.
    // Any other failure to read it is thrown, never read as no owner.
    if (isAbsentOrPartial(error)) return undefined;
    throw error;
  }
}

export async function readTicket(
  queueDirectory: string,
  name: string,
): Promise<OwnerRecord | undefined> {
  try {
    return JSON.parse(await readFile(join(queueDirectory, name), 'utf8')) as OwnerRecord;
  } catch (error) {
    // Gone (its waiter took its turn or gave up) or half written: no ticket to read yet.
    if (isAbsentOrPartial(error)) return undefined;
    throw error;
  }
}

export function describeHolder(holder: HostLockHolder | undefined): string {
  if (!holder) return 'a holder that has not recorded itself yet';
  return `pid ${holder.pid} running \`${holder.command}\` in ${holder.cwd} since ${holder.acquiredAt}`;
}

/** A unique name beside the lock to move it to before removing it. */
export function asideOf(lockDirectory: string): string {
  return `${lockDirectory}.removed-${process.pid}-${crypto.randomUUID()}`;
}

/**
 * Puts a lock moved aside by mistake back in place, or throws when another lock took the place
 * meanwhile: the moved lock's holder still runs believing it holds the lock, so two may run, and
 * only a person can tell which should stop.
 */
export async function putBack(
  lockDirectory: string,
  aside: string,
  moved: OwnerRecord | undefined,
  expected: string,
): Promise<void> {
  try {
    await rename(aside, lockDirectory);
  } catch (error) {
    const holder =
      moved === undefined ? 'a lock without an owner' : `the lock of ${describeHolder(moved)}`;
    throw new Error(
      `${lockDirectory} changed while ${expected} was being removed: ${holder} was moved aside to ${aside} and could not be put back (${errorCode(error) ?? String(error)}), because another lock was installed meanwhile. Two holders may now run.`,
      { cause: error },
    );
  }
}

/**
 * Removes the lock if it is still the one `expected` describes. A lock that is not that one is
 * left where it is, unmoved. `rename` is atomic, so waiters see the lock either whole or gone. If
 * the lock was replaced between the check and the move, what moved is put back, and a failure to
 * put it back is thrown, never swallowed ({@link putBack}). Callers make that case unreachable, a
 * holder by removing only its own lock and a reclaimer by holding the reclaim guard.
 */
export async function removeLock(lockDirectory: string, expected: OwnerRecord): Promise<void> {
  const current = await readOwner(lockDirectory);
  if (current?.token !== expected.token) return;
  const aside = asideOf(lockDirectory);
  try {
    await rename(lockDirectory, aside);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  const moved = await readOwner(aside);
  if (moved?.token === expected.token) {
    await rm(aside, { recursive: true, force: true });
    return;
  }
  await putBack(lockDirectory, aside, moved, `the lock of ${describeHolder(expected)}`);
}

/** Records the command's process group in the held lock, replacing the owner file in one rename. */
export async function recordProcessGroup(
  lockDirectory: string,
  owner: OwnerRecord,
  processGroup: number,
): Promise<void> {
  const staged = join(lockDirectory, `${ownerFileName}.${owner.token}`);
  const processGroupStartedAt = processStartTime(processGroup);
  await writeFile(
    staged,
    JSON.stringify({
      ...owner,
      processGroup,
      ...(processGroupStartedAt === undefined ? {} : { processGroupStartedAt }),
    }),
  );
  await rename(staged, join(lockDirectory, ownerFileName));
}
