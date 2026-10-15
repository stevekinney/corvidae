import type { Subprocess } from 'bun';
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  outcomeOf,
  rethrow,
  SCENARIO_HANG_GUARD_MILLISECONDS,
} from './module-scope-scenario.test-support.ts';
import { rejectionOf } from './promise-outcome.test-support.ts';
import {
  acquireHostLock,
  ownerFileName,
  reclaimAbandoned,
  runExclusively,
  type HostLockHolder,
  type OwnerRecord,
} from './run-exclusively';

/**
 * `acquireHostLock` and `processStartTime` run `ps`, and several scenarios start a real wrapper
 * process, so every scenario here runs once at module scope, off Bun's five-second per-test clock.
 * Each owns its lock directory and everything it started: it removes them in a `finally`, and the
 * hang guard releases them again if the scenario never settles. Scenarios run one after another,
 * because they share the host's process table.
 */
type Scratch = {
  directory: string;
  lockDirectory: string;
  /** Register something to undo when the scenario ends, however it ends. */
  onCleanup(cleanup: () => void): void;
  /** Undo every registered cleanup, newest first, then remove the directory. Safe to repeat. */
  dispose(): Promise<void>;
};

async function createScratch(): Promise<Scratch> {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-host-lock-'));
  const cleanups: (() => void)[] = [];
  return {
    directory,
    lockDirectory: join(directory, 'host-lock'),
    onCleanup: (cleanup) => {
      cleanups.push(cleanup);
    },
    dispose: async () => {
      for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Run one scenario against its own scratch directory and return what it threw. */
async function inScratchDirectory(body: (scratch: Scratch) => Promise<void>): Promise<unknown> {
  const held: { scratch?: Scratch } = {};
  const outcome = await outcomeOf(async () => {
    const scratch = await createScratch();
    held.scratch = scratch;
    try {
      await body(scratch);
    } finally {
      await scratch.dispose();
    }
  });
  // A scenario that hung is still suspended inside `body`; release what it holds.
  await held.scratch?.dispose();
  return outcome;
}

function holder(scratch: Scratch, pid = process.pid): HostLockHolder {
  return {
    pid,
    command: 'test',
    cwd: scratch.directory,
    acquiredAt: new Date(0).toISOString(),
  };
}

function isGroupAlive(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(processGroup: number | undefined): void {
  if (processGroup === undefined) return;
  try {
    process.kill(-processGroup, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** The pid of a process that has already exited, so nothing can be holding a lock under it. */
async function exitedPid(): Promise<number> {
  const child = Bun.spawn(['true'], { timeout: SCENARIO_HANG_GUARD_MILLISECONDS });
  await child.exited;
  return child.pid;
}

async function writeLock(scratch: Scratch, contents: OwnerRecord): Promise<void> {
  await mkdir(scratch.lockDirectory);
  await writeFile(join(scratch.lockDirectory, ownerFileName), JSON.stringify(contents));
}

/** Runs the real wrapper in its own process, so the scenario can signal it like an outside caller. */
async function startWrapper(
  scratch: Scratch,
  script: string,
): Promise<{ wrapper: Subprocess; processGroup: number }> {
  const fixture = join(scratch.directory, 'wrapper.ts');
  await writeFile(
    fixture,
    `import { runExclusively } from ${JSON.stringify(join(import.meta.dir, 'run-exclusively.ts'))};
process.exitCode = await runExclusively({
  lockDirectory: process.argv[2],
  script: process.argv[3],
  pollIntervalMs: 5,
  report: () => {},
});
`,
  );
  const wrapper = Bun.spawn([process.execPath, fixture, scratch.lockDirectory, script], {
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
  });
  scratch.onCleanup(() => wrapper.kill('SIGKILL'));
  for (;;) {
    const contents = await readFile(join(scratch.lockDirectory, ownerFileName), 'utf8').catch(
      () => '',
    );
    const processGroup = contents === '' ? undefined : JSON.parse(contents).processGroup;
    if (processGroup !== undefined) {
      scratch.onCleanup(() => killGroup(processGroup));
      return { wrapper, processGroup };
    }
    await Bun.sleep(5);
  }
}

const holdsUntilReleased = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  const lock = await acquireHostLock({ lockDirectory, holder: holder(scratch) });
  const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
  expect(recorded.pid).toBe(process.pid);
  expect(recorded.command).toBe('test');
  await lock.recordProcessGroup(4242);
  const updated = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
  expect(updated.processGroup).toBe(4242);
  await lock.release();
  expect(await Bun.file(join(lockDirectory, ownerFileName)).exists()).toBe(false);
});

const secondAcquirerWaits = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  const events: string[] = [];
  const first = await acquireHostLock({ lockDirectory, holder: holder(scratch) });
  const { promise: waiting, resolve: markWaiting } = Promise.withResolvers<void>();
  const second = acquireHostLock({
    lockDirectory,
    holder: holder(scratch),
    pollIntervalMs: 1,
    onWait: (current) => {
      events.push(`waiting on ${current?.command}`);
      markWaiting();
    },
  }).then((lock) => {
    events.push('second acquired');
    return lock;
  });
  await waiting;
  events.push('first released');
  await first.release();
  const acquired = await second;
  await acquired.release();
  expect(events).toEqual(['waiting on test', 'first released', 'second acquired']);
});

const reclaimsExitedHolder = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  await writeLock(scratch, { ...holder(scratch, await exitedPid()), token: 'stale' });
  const lock = await acquireHostLock({ lockDirectory, holder: holder(scratch), pollIntervalMs: 1 });
  const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
  expect(recorded.pid).toBe(process.pid);
  await lock.release();
});

const treatsUnsignalableHolderAsAlive = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  // Signalling pid 1 fails with EPERM: the process exists but belongs to another user.
  await writeLock(scratch, { ...holder(scratch, 1), token: 'foreign' });
  const controller = new AbortController();
  const reason = rejectionOf(
    acquireHostLock({
      lockDirectory,
      holder: holder(scratch),
      pollIntervalMs: 1,
      signal: controller.signal,
      onWait: () => controller.abort(),
    }),
  );
  expect(await reason).toBeInstanceOf(Error);
  const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
  expect(recorded.token).toBe('foreign');
});

const reclaimsOwnerlessDirectory = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  // Not empty: renaming onto an empty directory would replace it without reaching the
  // ownerless branch at all.
  await mkdir(lockDirectory);
  await writeFile(join(lockDirectory, 'stray'), '');
  const lock = await acquireHostLock({
    lockDirectory,
    holder: holder(scratch),
    pollIntervalMs: 1,
    ownerlessGraceMs: 0,
  });
  const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
  expect(recorded.pid).toBe(process.pid);
  await lock.release();
});

const staysHeldWhileGroupRuns = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  const group = spawn('sleep', ['30'], {
    detached: true,
    stdio: 'ignore',
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
  });
  scratch.onCleanup(() => killGroup(group.pid));
  await writeLock(scratch, {
    ...holder(scratch, await exitedPid()),
    processGroup: group.pid!,
    token: 'orphaned',
  });
  const controller = new AbortController();
  const reason = rejectionOf(
    acquireHostLock({
      lockDirectory,
      holder: holder(scratch),
      pollIntervalMs: 1,
      signal: controller.signal,
      onWait: () => controller.abort(),
    }),
  );
  expect(await reason).toBeInstanceOf(Error);
  const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
  expect(recorded.token).toBe('orphaned');
});

const doesNotMistakeRecycledPid = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  // This scenario's own pid is alive, but not the process that started at the recorded time.
  await writeLock(scratch, {
    ...holder(scratch),
    pidStartedAt: 'Thu Jan  1 00:00:00 1970',
    token: 'recycled',
  });
  const lock = await acquireHostLock({ lockDirectory, holder: holder(scratch), pollIntervalMs: 1 });
  const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
  expect(recorded.token).not.toBe('recycled');
  await lock.release();
});

const releaseKeepsSuccessorLock = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  const lock = await acquireHostLock({ lockDirectory, holder: holder(scratch) });
  await rm(lockDirectory, { recursive: true });
  await writeLock(scratch, { ...holder(scratch), token: 'successor' });
  await lock.release();
  const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
  expect(recorded.token).toBe('successor');
});

describe('acquireHostLock', () => {
  test('holds the lock until released, recording who holds it', () => rethrow(holdsUntilReleased));

  test('a second acquirer waits for the first to release', () => rethrow(secondAcquirerWaits));

  test('reclaims a lock whose holder has exited', () => rethrow(reclaimsExitedHolder));

  test('treats a holder it may not signal as alive rather than reclaiming it', () =>
    rethrow(treatsUnsignalableHolderAsAlive));

  test('reclaims a lock directory left without an owner once the grace period passes', () =>
    rethrow(reclaimsOwnerlessDirectory));

  test('stays held while the process group runs, even after the wrapper that took it has exited', () =>
    rethrow(staysHeldWhileGroupRuns));

  test('does not mistake a recycled pid for the holder', () => rethrow(doesNotMistakeRecycledPid));

  test('releasing never removes a lock someone else now holds', () =>
    rethrow(releaseKeepsSuccessorLock));
});

const leavesLockLiveByTheTimeGuardIsHeld = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  // A waiter judged an earlier lock abandoned, but another waiter replaced it before this
  // reclaim took the guard.
  await writeLock(scratch, { ...holder(scratch), token: 'live' });
  await reclaimAbandoned(lockDirectory, 10_000);
  const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
  expect(recorded.token).toBe('live');
});

const leavesLockToReclaimerHoldingGuard = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  const stale: OwnerRecord = { ...holder(scratch, await exitedPid()), token: 'stale' };
  await writeLock(scratch, stale);
  await mkdir(`${lockDirectory}.reclaiming`);
  await reclaimAbandoned(lockDirectory, 10_000);
  const recorded = JSON.parse(await readFile(join(lockDirectory, ownerFileName), 'utf8'));
  expect(recorded.token).toBe('stale');
});

const removesStillAbandonedLock = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  const stale: OwnerRecord = { ...holder(scratch, await exitedPid()), token: 'stale' };
  await writeLock(scratch, stale);
  await reclaimAbandoned(lockDirectory, 10_000);
  expect(await Bun.file(join(lockDirectory, ownerFileName)).exists()).toBe(false);
  const guard = await stat(`${lockDirectory}.reclaiming`).catch(() => undefined);
  expect(guard).toBeUndefined();
});

describe('reclaimAbandoned', () => {
  test('leaves a lock that is live by the time the guard is held', () =>
    rethrow(leavesLockLiveByTheTimeGuardIsHeld));

  test('leaves the lock to the reclaimer already holding the guard', () =>
    rethrow(leavesLockToReclaimerHoldingGuard));

  test('removes a lock that is still the abandoned one', () => rethrow(removesStillAbandonedLock));
});

const signalReachesChainedCommand = await inScratchDirectory(async (scratch) => {
  const { wrapper, processGroup } = await startWrapper(scratch, 'sleep 30 && true');
  wrapper.kill('SIGTERM');
  await wrapper.exited;
  expect(isGroupAlive(processGroup)).toBe(false);
  expect(await Bun.file(join(scratch.lockDirectory, ownerFileName)).exists()).toBe(false);
});

const killedWrapperLeavesLockHeld = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  const { wrapper, processGroup } = await startWrapper(scratch, 'sleep 30 && true');
  wrapper.kill('SIGKILL');
  await wrapper.exited;
  const controller = new AbortController();
  const waited = rejectionOf(
    acquireHostLock({
      lockDirectory,
      holder: holder(scratch),
      pollIntervalMs: 1,
      signal: controller.signal,
      onWait: () => controller.abort(),
    }),
  );
  expect(await waited).toBeInstanceOf(Error);
  killGroup(processGroup);
  const lock = await acquireHostLock({ lockDirectory, holder: holder(scratch), pollIntervalMs: 1 });
  await lock.release();
});

describe('the wrapper as a process', () => {
  test('a signal to the wrapper reaches the whole chained command before the lock is released', () =>
    rethrow(signalReachesChainedCommand));

  test('a killed wrapper leaves the lock held until its process group is gone', () =>
    rethrow(killedWrapperLeavesLockHeld));
});

const concurrentRunsNeverOverlap = await inScratchDirectory(async (scratch) => {
  const { lockDirectory, directory } = scratch;
  const log = join(directory, 'log');
  const script = `echo start >> '${log}'; sleep 0.2; echo end >> '${log}'`;
  const codes = await Promise.all([
    runExclusively({ lockDirectory, script, pollIntervalMs: 5, report: () => {} }),
    runExclusively({ lockDirectory, script, pollIntervalMs: 5, report: () => {} }),
  ]);
  expect(codes).toEqual([0, 0]);
  const lines = await readFile(log, 'utf8');
  expect(lines.trim().split('\n')).toEqual(['start', 'end', 'start', 'end']);
});

const returnsExitCodeAndReleases = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  expect(await runExclusively({ lockDirectory, script: 'exit 3', report: () => {} })).toBe(3);
  expect(await Bun.file(join(lockDirectory, ownerFileName)).exists()).toBe(false);
});

const passesArgumentsIntact = await inScratchDirectory(async (scratch) => {
  const { lockDirectory, directory } = scratch;
  const output = join(directory, 'arguments');
  const code = await runExclusively({
    lockDirectory,
    script: `printf '%s\\n' > '${output}'`,
    args: ['two words', '--flag'],
    report: () => {},
  });
  expect(code).toBe(0);
  const written = await readFile(output, 'utf8');
  expect(written.split('\n')).toEqual(['two words', '--flag', '']);
});

const terminatesLeftBehindProcesses = await inScratchDirectory(async (scratch) => {
  const { lockDirectory, directory } = scratch;
  const groupFile = join(directory, 'group');
  // `$$` in `sh -c` is the shell's pid, which leads the command's process group.
  const code = await runExclusively({
    lockDirectory,
    script: `sleep 30 & echo $$ > '${groupFile}'`,
    report: () => {},
  });
  expect(code).toBe(0);
  const processGroup = Number(await readFile(groupFile, 'utf8'));
  expect(isGroupAlive(processGroup)).toBe(false);
});

const runsUnlockedWhenLockCannotBeCreated = await inScratchDirectory(async (scratch) => {
  const { directory } = scratch;
  const reports: string[] = [];
  const blocked = join(directory, 'a-file');
  await writeFile(blocked, '');
  const code = await runExclusively({
    lockDirectory: join(blocked, 'host-lock'),
    script: 'exit 0',
    report: (line) => reports.push(line),
  });
  expect(code).toBe(0);
  expect(reports.join('\n')).toContain('running without the host lock');
});

describe('runExclusively', () => {
  test('two concurrent runs never overlap', () => rethrow(concurrentRunsNeverOverlap));

  test("returns the command's exit code and releases the lock after a failure", () =>
    rethrow(returnsExitCodeAndReleases));

  test('passes arguments through with their boundaries intact', () =>
    rethrow(passesArgumentsIntact));

  test('terminates processes the command left behind before releasing', () =>
    rethrow(terminatesLeftBehindProcesses));

  test('runs unlocked with a warning when the lock cannot be created', () =>
    rethrow(runsUnlockedWhenLockCannotBeCreated));
});
