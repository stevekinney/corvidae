// --- Reclaiming an abandoned lock ----------------------------------------------------------------
//
// One guard serializes the reclaimers of a lock: the host lock's, each test slot's, the admission
// lock of `scripts/host-sessions.ts`, and an owned process lease's. The guard is a directory beside
// the lock, taken by an exclusive `mkdir` as older checkouts take it, holding one token file per
// reclaimer, named by its token and recording its process. Every removal names something only its
// creator could name, or is an `rmdir`, which removes only an empty directory: a reclaimer removes
// its own token, and the guard only after removing it; a guard whose every token's process is gone
// loses each of those tokens by name. A guard is never judged stale by its age while a token in it
// names a live process, so a reclaimer that stalls keeps its guard, and a reclaimer acting on a
// stale reading can remove nothing but what it read. A guard with no token, an older checkout's or
// one whose creator died before writing its token, is judged by its age, as before (COR-2463).

import { mkdir, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  asideOf,
  errorCode,
  putBack,
  readOwner,
  readTicket,
  removeLock,
  statIfPresent,
  type OwnerRecord,
} from './lock-records.ts';
import { isProcessGroupAlive, isSameProcess } from './process-identity.ts';

/** How long a reclaim guard without a token may stand before it counts as left by one that died. */
export const tokenlessGuardStaleMs = 30_000;

const claimSuffix = '.json';

/** The reclaim guard beside a lock. */
export function reclaimGuardFor(lockDirectory: string): string {
  return `${lockDirectory}.reclaiming`;
}

/** Judges whether recorded processes still run; called afresh after each listing it judges. */
export type LivenessJudge = () => (record: OwnerRecord) => boolean;

/** Alive while its process, or the process group it recorded, runs. */
export const judgeByProcess: LivenessJudge = () => (record) =>
  isSameProcess(record.pid, record.pidStartedAt) ||
  (record.processGroup !== undefined &&
    isProcessGroupAlive(record.processGroup, record.processGroupStartedAt));

async function readClaims(guard: string): Promise<{ name: string; record?: OwnerRecord }[]> {
  const names = await readdir(guard).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return [] as string[];
    throw error;
  });
  return Promise.all(
    names
      .filter((name) => name.endsWith(claimSuffix))
      .map(async (name) => {
        const record = await readTicket(guard, name);
        return record === undefined ? { name } : { name, record };
      }),
  );
}

async function removeEmptyGuard(guard: string): Promise<void> {
  await rmdir(guard).catch((error: unknown) => {
    const code = errorCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  });
}

/**
 * Clears a guard someone else holds once nobody can still be inside it: each token whose process
 * is gone is removed by its own name, and a guard without a token once it is older than
 * {@link tokenlessGuardStaleMs}; the directory itself only by `rmdir`.
 */
async function clearAbandonedGuard(guard: string, judge: LivenessJudge): Promise<void> {
  const claims = await readClaims(guard);
  if (claims.length > 0) {
    const isAlive = judge();
    if (claims.some(({ record }) => record !== undefined && isAlive(record))) return;
    for (const { name } of claims) {
      await unlink(join(guard, name)).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
    }
  } else {
    const written = await statIfPresent(guard);
    if (written === undefined || Date.now() - Math.floor(written.mtimeMs) < tokenlessGuardStaleMs)
      return;
  }
  await removeEmptyGuard(guard);
}

/** Removes the claimant's token, then the guard if that left it empty. */
async function leaveReclaimGuard(guard: string, claim: string): Promise<void> {
  const removed = await unlink(claim).then(
    () => true,
    (error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error;
      return false;
    },
  );
  // Without its token the guard may be another's by now: an older checkout's hook can remove a
  // guard by its age alone, and a new guard can stand in its place.
  if (removed) await removeEmptyGuard(guard);
}

/**
 * Takes the reclaim guard of `lockDirectory` for `claimant`, or resolves to undefined when another
 * reclaimer may be inside. Resolves to the function that leaves it. The token is written aside and
 * renamed in, so it is never read half-written; it lands in no guard if this one was removed first,
 * and in someone else's if that guard replaced it, which the listing after it catches: a reclaimer
 * goes in only when no other token in the guard names a live process, so of two that wrote theirs
 * into one guard, the later listing sees the earlier token and backs off.
 */
export async function takeReclaimGuard(
  lockDirectory: string,
  claimant: OwnerRecord,
  judge: LivenessJudge,
): Promise<(() => Promise<void>) | undefined> {
  const guard = reclaimGuardFor(lockDirectory);
  try {
    await mkdir(guard);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    await clearAbandonedGuard(guard, judge);
    return undefined;
  }
  const claim = join(guard, `${claimant.token}${claimSuffix}`);
  const staged = `${guard}.staged-${claimant.token}`;
  await writeFile(staged, JSON.stringify(claimant));
  try {
    await rename(staged, claim);
  } catch (error) {
    await rm(staged, { force: true });
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  const leave = () => leaveReclaimGuard(guard, claim);
  const claims = await readClaims(guard);
  // Judged after the listing, so a reclaimer whose token is listed is in what judges it.
  const isAlive = judge();
  const others = claims.filter(
    ({ name, record }) => name !== basename(claim) && record !== undefined && isAlive(record),
  );
  if (others.length > 0) {
    await leave();
    return undefined;
  }
  return leave;
}

/**
 * Removes what stands at the lock's path without an owner file, while it is still the entry
 * `identity` names. An empty directory goes by `rmdir`, which removes only an empty directory, and
 * a lock is never installed empty. A non-empty directory, or a file, cannot be replaced, since a
 * rename onto either fails, so the entry moved aside is the one judged. Resolves to whether it is
 * gone.
 */
async function removeOwnerless(lockDirectory: string, identity: number): Promise<boolean> {
  const entries = await readdir(lockDirectory).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return undefined;
    if (errorCode(error) === 'ENOTDIR') return [lockDirectory];
    throw error;
  });
  if (entries === undefined) return true;
  if (entries.length === 0) {
    return rmdir(lockDirectory).then(
      () => true,
      (error: unknown) => {
        // Gone already, or no longer empty because a lock was installed onto it: anything else
        // (a permission, say) is thrown, never taken for a lock that is still held.
        const code = errorCode(error);
        if (code === 'ENOENT') return true;
        if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
        throw error;
      },
    );
  }
  const aside = asideOf(lockDirectory);
  try {
    await rename(lockDirectory, aside);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    throw error;
  }
  const moved = await stat(aside);
  const owner = await readOwner(aside);
  if (moved.ino === identity && owner === undefined) {
    await rm(aside, { recursive: true, force: true });
    return true;
  }
  await putBack(lockDirectory, aside, owner, 'a lock directory without an owner');
  return false;
}

/**
 * Whether the lock is gone (released or removed), judged under the guard. A lock with an owner is
 * judged only by its owner's process, never by its age. A directory without an owner file is
 * judged by its age, and only when the same directory stood before and after the owner was read:
 * locks are installed whole, so the owner read was that directory's, not a lock installed between
 * the two looks.
 */
async function reclaimUnderGuard(
  lockDirectory: string,
  ownerlessGraceMs: number,
  judge: LivenessJudge,
): Promise<boolean> {
  const before = await statIfPresent(lockDirectory);
  if (before === undefined) return true;
  const owner = await readOwner(lockDirectory);
  if (owner !== undefined) {
    if (judge()(owner)) return false;
    await removeLock(lockDirectory, owner);
    return true;
  }
  const after = await statIfPresent(lockDirectory);
  if (after === undefined) return true;
  if (after.ino !== before.ino) return false;
  // Whole milliseconds on both sides: `mtimeMs` keeps a fraction `Date.now()` drops, so a
  // directory written earlier in this millisecond would otherwise read as written in the future.
  if (Date.now() - Math.floor(after.mtimeMs) < ownerlessGraceMs) return false;
  return removeOwnerless(lockDirectory, after.ino);
}

export type Reclaimer = {
  /** Judges the lock's owner and the other reclaimers' tokens. */
  readonly judge: LivenessJudge;
  /** Who reclaims, recorded in its token. */
  readonly claimant: OwnerRecord;
};

/**
 * Removes the lock if it is abandoned, judged while holding the reclaim guard
 * ({@link takeReclaimGuard}), and resolves to whether the lock is gone. Reclaims are serialized
 * behind the guard and the lock is read again under it. No holder can install a lock while an
 * abandoned one stands, and no other reclaimer can move it, so the lock judged under the guard is
 * the lock removed. Judging it before taking the guard would let a waiter acting on a stale
 * reading move aside a live lock another waiter had just installed. The admission lock of
 * `scripts/host-sessions.ts` calls it with its own process table; the host lock and the test slots
 * judge by `ps`, as this process.
 */
export async function reclaimAbandonedAs(
  lockDirectory: string,
  ownerlessGraceMs: number,
  { judge, claimant }: Reclaimer,
): Promise<boolean> {
  const leave = await takeReclaimGuard(lockDirectory, claimant, judge);
  if (leave === undefined) return false;
  try {
    return await reclaimUnderGuard(lockDirectory, ownerlessGraceMs, judge);
  } finally {
    await leave();
  }
}
