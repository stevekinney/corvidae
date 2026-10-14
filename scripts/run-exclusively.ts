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
 * file records the holder's pid, so a waiter can reclaim a lock whose holder died holding it.
 *
 * Usage: `bun scripts/run-exclusively.ts '<shell command>'`.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const ownerFileName = 'owner.json';

export type HostLockHolder = {
  readonly pid: number;
  readonly command: string;
  readonly cwd: string;
  readonly acquiredAt: string;
};

type OwnerRecord = HostLockHolder & { readonly token: string };

export type AcquireHostLockOptions = {
  readonly lockDirectory: string;
  readonly holder: HostLockHolder;
  /** How often a waiter checks the lock again. */
  readonly pollIntervalMs?: number;
  /**
   * How long a lock directory may lack an owner file before it counts as abandoned. A holder
   * writes the file right after creating the directory, so only a crash between the two leaves
   * it missing.
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

/**
 * Whether the lock is still there and, if so, whether its holder is gone. A lock without a
 * readable owner file is never written by this module, which installs the owner and the directory
 * in one rename, so one is only abandoned once it has sat that way for the grace period.
 */
async function lockState(
  lockDirectory: string,
  owner: OwnerRecord | undefined,
  ownerlessGraceMs: number,
): Promise<'released' | 'abandoned' | 'held'> {
  if (owner) return isProcessAlive(owner.pid) ? 'held' : 'abandoned';
  try {
    const { mtimeMs } = await stat(lockDirectory);
    return Date.now() - mtimeMs >= ownerlessGraceMs ? 'abandoned' : 'held';
  } catch {
    return 'released';
  }
}

/**
 * Removes the lock if it is still the one `expected` describes. `rename` is atomic, so waiters see
 * the lock either whole or gone, and when two processes move it at once only one succeeds. If what
 * moved is not the expected lock (another holder took over in between), it is put back.
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

/** Waits until it holds the lock, then resolves to the function that releases it. */
export async function acquireHostLock(
  options: AcquireHostLockOptions,
): Promise<() => Promise<void>> {
  const { lockDirectory, holder, pollIntervalMs = 1000, ownerlessGraceMs = 10_000 } = options;
  const self: OwnerRecord = { ...holder, token: crypto.randomUUID() };
  let lastWaitedOn: string | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    if (await tryInstall(lockDirectory, self)) {
      return () => removeLock(lockDirectory, self);
    }
    const owner = await readOwner(lockDirectory);
    const state = await lockState(lockDirectory, owner, ownerlessGraceMs);
    if (state === 'released') continue;
    if (state === 'abandoned') {
      await removeLock(lockDirectory, owner);
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
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireHostLock({
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
    const child = Bun.spawn(['sh', '-c', options.script], {
      stdio: ['inherit', 'inherit', 'inherit'],
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
    await release?.();
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
  const script = process.argv.slice(2).join(' ');
  if (script === '') {
    process.stderr.write("usage: bun scripts/run-exclusively.ts '<shell command>'\n");
    process.exitCode = 64;
  } else {
    process.exitCode = await runExclusively({ lockDirectory: hostLockDirectory(), script });
  }
}
