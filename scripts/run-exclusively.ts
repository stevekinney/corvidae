/**
 * Runs a heavy root stage under a lock that every checkout of this repository on the host shares.
 *
 * Each `bun run validate` assumes it has the machine to itself. With a dozen agent sessions
 * validating at once on a ten-core host, the load average reaches 100–200 and tests that do real
 * work inside Bun's five-second default time out at random, a different one each run. Queueing
 * the heavy stages turns that noise into waiting, which is slower per run but deterministic.
 *
 * The lock is a directory inside the Git common directory, which every worktree of this
 * repository shares. It is renamed into place with its owner file already inside, and `rename`
 * refuses to replace a non-empty directory, so whoever's rename succeeds holds the lock. The owner
 * file records the wrapper's pid and, once it starts, the command's. The lock stays held while
 * either is alive, so a waiter reclaims it only once the work it guarded has stopped.
 *
 * Usage: `bun scripts/run-exclusively.ts '<shell command>' [arguments...]`. Arguments reach the
 * command as `"$@"`, so their boundaries survive, the way `bun run <script> -- …` passes them.
 */

import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const ownerFileName = 'owner.json';

export type HostLockHolder = {
  readonly pid: number;
  /** The command's own pid, recorded once it starts; it can outlive a killed wrapper. */
  readonly commandPid?: number;
  readonly command: string;
  readonly cwd: string;
  readonly acquiredAt: string;
};

export type OwnerRecord = HostLockHolder & { readonly token: string };

export type AcquireHostLockOptions = {
  readonly lockDirectory: string;
  readonly holder: HostLockHolder;
  /** How often a waiter checks the lock again. */
  readonly pollIntervalMs?: number;
  /**
   * How long a lock directory without a readable owner file may stand before it counts as
   * abandoned. This module never creates one, since it installs the owner and the directory in
   * one rename, so such a directory was left by something else.
   */
  readonly ownerlessGraceMs?: number;
  /** Called whenever the holder a waiter is queued behind changes, including the first time. */
  readonly onWait?: (holder: HostLockHolder | undefined) => void;
  readonly signal?: AbortSignal;
};

/** Whether `pid` names a live process. Only ESRCH means it is gone; EPERM means it exists. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readOwner(lockDirectory: string): Promise<OwnerRecord | undefined> {
  try {
    return JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8')) as OwnerRecord;
  } catch {
    return undefined;
  }
}

/** Whether the lock is still there and, if so, whether everything it guarded has stopped. */
async function lockState(
  lockDirectory: string,
  owner: OwnerRecord | undefined,
  ownerlessGraceMs: number,
): Promise<'released' | 'abandoned' | 'held'> {
  if (owner) {
    const alive =
      isProcessAlive(owner.pid) ||
      (owner.commandPid !== undefined && isProcessAlive(owner.commandPid));
    return alive ? 'held' : 'abandoned';
  }
  try {
    const { mtimeMs } = await stat(lockDirectory);
    return Date.now() - mtimeMs >= ownerlessGraceMs ? 'abandoned' : 'held';
  } catch {
    return 'released';
  }
}

/**
 * Removes the lock if it is still the one `expected` describes. `rename` is atomic, so waiters see
 * the lock either whole or gone. If what moved is not the expected lock, it is put back; callers
 * make that case unreachable, a holder by removing only its own lock and a reclaimer by holding
 * the reclaim guard.
 */
async function removeLock(lockDirectory: string, expected: OwnerRecord | undefined): Promise<void> {
  const aside = `${lockDirectory}.removed-${process.pid}-${crypto.randomUUID()}`;
  try {
    await rename(lockDirectory, aside);
  } catch {
    return;
  }
  const moved = await readOwner(aside);
  if (moved?.token !== expected?.token) {
    await rename(aside, lockDirectory).catch(() => undefined);
    return;
  }
  await rm(aside, { recursive: true, force: true });
}

/**
 * Builds a lock directory beside the real one and renames it into place, so the lock never exists
 * without its owner file. Renaming a directory onto a non-empty one fails, which is how a held
 * lock refuses a second holder. Resolves to whether this call took the lock.
 */
async function tryInstall(lockDirectory: string, owner: OwnerRecord): Promise<boolean> {
  const pending = `${lockDirectory}.pending-${owner.token}`;
  await mkdir(pending);
  try {
    await writeFile(join(pending, ownerFileName), JSON.stringify(owner));
    await rename(pending, lockDirectory);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    return false;
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}

/** How long a reclaim guard may stand before it counts as left by a reclaimer that died. */
const reclaimGuardStaleMs = 30_000;

/**
 * Removes the lock if it is abandoned, judged while holding a reclaim guard. Reclaims are
 * serialized behind the guard directory and the lock is read again under it. No holder can install
 * a lock while an abandoned one stands, and no other reclaimer can move it, so the lock judged
 * under the guard is the lock removed. Judging it before taking the guard would let a waiter acting
 * on a stale reading move aside a live lock another waiter had just installed.
 */
export async function reclaimAbandoned(
  lockDirectory: string,
  ownerlessGraceMs: number,
): Promise<void> {
  const guard = `${lockDirectory}.reclaiming`;
  try {
    await mkdir(guard);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const { mtimeMs } = await stat(guard).catch(() => ({ mtimeMs: Date.now() }));
    if (Date.now() - mtimeMs >= reclaimGuardStaleMs) await rmdir(guard).catch(() => undefined);
    return;
  }
  try {
    const current = await readOwner(lockDirectory);
    if ((await lockState(lockDirectory, current, ownerlessGraceMs)) !== 'abandoned') return;
    await removeLock(lockDirectory, current);
  } finally {
    await rmdir(guard).catch(() => undefined);
  }
}

/** Records the command's pid in the held lock, replacing the owner file in one rename. */
async function recordCommandPid(
  lockDirectory: string,
  owner: OwnerRecord,
  commandPid: number,
): Promise<void> {
  const staged = join(lockDirectory, `${ownerFileName}.${owner.token}`);
  await writeFile(staged, JSON.stringify({ ...owner, commandPid }));
  await rename(staged, join(lockDirectory, ownerFileName));
}

function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type HeldHostLock = {
  /** Records the guarded command's pid, so the lock outlives a wrapper killed before it. */
  readonly recordCommand: (commandPid: number) => Promise<void>;
  readonly release: () => Promise<void>;
};

/** Waits until it holds the lock. */
export async function acquireHostLock(options: AcquireHostLockOptions): Promise<HeldHostLock> {
  const { lockDirectory, holder, pollIntervalMs = 1000, ownerlessGraceMs = 10_000 } = options;
  const self: OwnerRecord = { ...holder, token: crypto.randomUUID() };
  let lastWaitedOn: string | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    if (await tryInstall(lockDirectory, self)) {
      return {
        recordCommand: (commandPid) => recordCommandPid(lockDirectory, self, commandPid),
        release: () => removeLock(lockDirectory, self),
      };
    }
    const owner = await readOwner(lockDirectory);
    const state = await lockState(lockDirectory, owner, ownerlessGraceMs);
    if (state === 'released') continue;
    if (state === 'abandoned') {
      await reclaimAbandoned(lockDirectory, ownerlessGraceMs);
      await delay(Math.min(pollIntervalMs, 50), options.signal);
      continue;
    }
    const waitedOn = owner?.token ?? 'ownerless';
    if (waitedOn !== lastWaitedOn) {
      lastWaitedOn = waitedOn;
      options.onWait?.(owner);
    }
    await delay(pollIntervalMs, options.signal);
  }
}

export type RunExclusivelyOptions = {
  /** Resolving it may fail; the command then runs without the lock rather than not at all. */
  readonly lockDirectory: string | Promise<string>;
  readonly script: string;
  /** Passed to the command as `"$@"`. */
  readonly args?: readonly string[];
  readonly pollIntervalMs?: number;
  readonly report?: (line: string) => void;
};

function describeHolder(holder: HostLockHolder | undefined): string {
  if (!holder) return 'a holder that has not recorded itself yet';
  return `pid ${holder.pid} running \`${holder.command}\` in ${holder.cwd} since ${holder.acquiredAt}`;
}

/** Runs `script` through `sh -c` while holding the host lock and resolves to its exit code. */
export async function runExclusively(options: RunExclusivelyOptions): Promise<number> {
  const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));
  let lock: HeldHostLock | undefined;
  try {
    lock = await acquireHostLock({
      lockDirectory: await options.lockDirectory,
      holder: {
        pid: process.pid,
        command: options.script,
        cwd: process.cwd(),
        acquiredAt: new Date().toISOString(),
      },
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      onWait: (holder) =>
        report(`run-exclusively: waiting for the host lock held by ${describeHolder(holder)}`),
    });
  } catch (error) {
    report(`run-exclusively: running without the host lock: ${(error as Error).message}`);
  }
  try {
    const args = options.args ?? [];
    const command = args.length === 0 ? options.script : `${options.script} "$@"`;
    const child = Bun.spawn(['sh', '-c', command, 'sh', ...args], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    await lock?.recordCommand(child.pid).catch((error: unknown) => {
      report(`run-exclusively: could not record the command in the host lock: ${String(error)}`);
    });
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    try {
      const exitCode = await child.exited;
      if (child.signalCode) return 128 + (constants.signals[child.signalCode] ?? 0);
      return exitCode;
    } finally {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
    }
  } finally {
    await lock?.release();
  }
}

/** The lock directory inside this repository's Git common directory, shared by every worktree. */
async function hostLockDirectory(): Promise<string> {
  const git = Bun.spawn(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const text = await new Response(git.stdout).text();
  const output = text.trim();
  if ((await git.exited) !== 0 || output === '') {
    throw new Error('run-exclusively must run inside a Git checkout of this repository');
  }
  if (!isAbsolute(output)) throw new Error(`git returned a relative common directory: ${output}`);
  return join(output, 'corvidae-host-lock');
}

if (import.meta.main) {
  const [script = '', ...args] = process.argv.slice(2);
  if (script === '') {
    process.stderr.write(
      "usage: bun scripts/run-exclusively.ts '<shell command>' [arguments...]\n",
    );
    process.exitCode = 64;
  } else {
    process.exitCode = await runExclusively({ lockDirectory: hostLockDirectory(), script, args });
  }
}
