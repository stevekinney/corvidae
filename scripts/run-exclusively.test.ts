import type { Subprocess } from 'bun';
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { rejectionOf } from '../testing/testing/src/helpers/promise-outcome.ts';
import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';
import {
  acquireHostLock,
  heldLockTokenVariable,
  loadWaitLimitMs,
  ownerFileName,
  queueDirectoryFor,
  reclaimAbandoned,
  runExclusively,
  waitForLowLoad,
  withPreflight,
  withTurborepoDefaults,
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
  const child = spawnWithHangGuard(['true']);
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
  const wrapper = spawnWithHangGuard([process.execPath, fixture, scratch.lockDirectory, script], {
    stdio: ['ignore', 'ignore', 'inherit'],
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
  const group = spawnWithHangGuard(['sleep', '30'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  scratch.onCleanup(() => killGroup(group.pid));
  await writeLock(scratch, {
    ...holder(scratch, await exitedPid()),
    processGroup: group.pid,
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

const sharedRunsBesideAHeldLock = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  const held = await acquireHostLock({
    lockDirectory,
    holder: {
      pid: process.pid,
      command: 'a full validate',
      cwd: scratch.directory,
      acquiredAt: new Date().toISOString(),
    },
  });
  try {
    const reports: string[] = [];
    // `bun run check` runs shared: it neither waits for the held lock nor queues a ticket behind it.
    expect(
      await runExclusively({
        lockDirectory,
        script: 'exit 4',
        shared: true,
        // The real load average would make this scenario depend on how busy the host is.
        loadAverage: () => 0,
        report: (line) => reports.push(line),
      }),
    ).toBe(4);
    expect(reports).toEqual([]);
    expect(await readdir(queueDirectoryFor(lockDirectory)).catch(() => [])).toEqual([]);
  } finally {
    await held.release();
  }
});

const sharedRunWaitsOutAnOverloadedHost = await inScratchDirectory(async (scratch) => {
  const marker = join(scratch.directory, 'ran');
  const loads = [30, 30, 21, 5];
  const reports: string[] = [];
  const events: string[] = [];
  const code = await runExclusively({
    lockDirectory: scratch.lockDirectory,
    script: `touch ${marker}`,
    shared: true,
    processors: 10,
    loadAverage: () => loads.shift() ?? 0,
    now: () => 0,
    sleep: async () => {
      events.push(
        `sleep:${await stat(marker).then(
          () => 'after',
          () => 'before',
        )}`,
      );
    },
    report: (line) => reports.push(line),
  });
  expect(code).toBe(0);
  // The command ran only after the last sleep, and the unchanged 30 reported once.
  expect(events).toEqual(['sleep:before', 'sleep:before', 'sleep:before']);
  expect(reports).toEqual([
    'run-exclusively: shared run waiting for load 30.00 to fall below 20.00',
    'run-exclusively: shared run waiting for load 21.00 to fall below 20.00',
  ]);
  await stat(marker);
});

const lockedRunNeverReadsTheLoad = await inScratchDirectory(async (scratch) => {
  const code = await runExclusively({
    lockDirectory: scratch.lockDirectory,
    script: 'exit 0',
    loadAverage: () => {
      throw new Error('a locked run read the load average');
    },
    sleep: async () => {
      throw new Error('a locked run slept for load');
    },
  });
  expect(code).toBe(0);
});

describe('waitForLowLoad', () => {
  /** A fake clock whose sleep advances it, and a load reader that follows `loads` then repeats the last. */
  function fakeHost(loads: number[]) {
    let clock = 1_000;
    const sleeps: number[] = [];
    const reports: string[] = [];
    let index = 0;
    return {
      sleeps,
      reports,
      options: {
        processors: 4,
        loadAverage: () => loads[Math.min(index++, loads.length - 1)] ?? 0,
        now: () => clock,
        sleep: async (milliseconds: number) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
        },
        report: (line: string) => reports.push(line),
      },
    };
  }

  test('does not wait, or print, when the load is at or below processors × 2', async () => {
    const host = fakeHost([8]);
    await waitForLowLoad(host.options);
    expect(host.sleeps).toEqual([]);
    expect(host.reports).toEqual([]);
  });

  test('polls every 15 seconds and prints one line per change of load', async () => {
    const host = fakeHost([12, 12, 9.5, 9.5, 7]);
    await waitForLowLoad(host.options);
    expect(host.sleeps).toEqual([15_000, 15_000, 15_000, 15_000]);
    expect(host.reports).toEqual([
      'run-exclusively: shared run waiting for load 12.00 to fall below 8.00',
      'run-exclusively: shared run waiting for load 9.50 to fall below 8.00',
    ]);
  });

  test('gives up after 20 minutes of waiting and lets the run proceed', async () => {
    const host = fakeHost([50]);
    await waitForLowLoad(host.options);
    expect(host.sleeps).toHaveLength(80);
    expect(host.sleeps.reduce((total, value) => total + value, 0)).toBe(loadWaitLimitMs);
    expect(host.reports).toHaveLength(2);
    expect(host.reports[1]).toContain('still above 8.00 after 20 minutes; running anyway');
  });
});

describe('runExclusively', () => {
  test('a shared run neither waits for nor queues behind a held lock', () =>
    rethrow(sharedRunsBesideAHeldLock));

  test('a shared run waits for an overloaded host to quiet down before it runs', () =>
    rethrow(sharedRunWaitsOutAnOverloadedHost));

  test('a locked run never reads the load average', () => rethrow(lockedRunNeverReadsTheLoad));

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

/** Resolves once `count` tickets are queued beside the lock, so arrival order is under the test's control. */
async function waitForTickets(lockDirectory: string, count: number): Promise<void> {
  for (;;) {
    const tickets = await readdir(queueDirectoryFor(lockDirectory)).catch(() => []);
    if (tickets.length >= count) return;
    await Bun.sleep(2);
  }
}

async function writeTicket(
  lockDirectory: string,
  name: string,
  contents: OwnerRecord,
): Promise<void> {
  await mkdir(queueDirectoryFor(lockDirectory), { recursive: true });
  await writeFile(join(queueDirectoryFor(lockDirectory), name), JSON.stringify(contents));
}

const grantsInArrivalOrder = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  const first = await acquireHostLock({ lockDirectory, holder: holder(scratch) });
  const order: number[] = [];
  const waiters: Promise<void>[] = [];
  for (let index = 0; index < 5; index++) {
    // Different poll intervals would let a later, faster poller win without a queue.
    waiters.push(
      acquireHostLock({
        lockDirectory,
        holder: holder(scratch),
        pollIntervalMs: index % 2 === 0 ? 1 : 7,
      }).then(async (lock) => {
        order.push(index);
        await Bun.sleep(3);
        await lock.release();
      }),
    );
    await waitForTickets(lockDirectory, index + 1);
  }
  await first.release();
  await Promise.all(waiters);
  expect(order).toEqual([0, 1, 2, 3, 4]);
  expect(await readdir(queueDirectoryFor(lockDirectory))).toEqual([]);
});

const livingEarlierWaiterBlocksLaterOnes = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  // The lock is free, but a live waiter arrived first and has not taken its turn yet.
  await writeTicket(lockDirectory, '0000000000000001-earlier.json', {
    ...holder(scratch),
    token: 'earlier',
  });
  const controller = new AbortController();
  const reason = rejectionOf(
    acquireHostLock({
      lockDirectory,
      holder: holder(scratch),
      pollIntervalMs: 1,
      signal: controller.signal,
      onWait: () => setTimeout(() => controller.abort(), 20),
    }),
  );
  expect(await reason).toBeInstanceOf(Error);
  expect(await Bun.file(join(lockDirectory, ownerFileName)).exists()).toBe(false);
  // The abandoned wait left only the earlier waiter's ticket behind.
  expect(await readdir(queueDirectoryFor(lockDirectory))).toEqual([
    '0000000000000001-earlier.json',
  ]);
});

const skipsDeadWaiter = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  const holding = await acquireHostLock({ lockDirectory, holder: holder(scratch) });
  await writeTicket(lockDirectory, '0000000000000001-dead.json', {
    ...holder(scratch, await exitedPid()),
    token: 'dead',
  });
  await writeTicket(lockDirectory, '0000000000000002-recycled.json', {
    ...holder(scratch),
    pidStartedAt: 'Thu Jan  1 00:00:00 1970',
    token: 'recycled',
  });
  const { promise: waiting, resolve: markWaiting } = Promise.withResolvers<void>();
  const next = acquireHostLock({
    lockDirectory,
    holder: holder(scratch),
    pollIntervalMs: 1,
    onWait: () => markWaiting(),
  });
  await waiting;
  await holding.release();
  const lock = await next;
  await lock.release();
  expect(await readdir(queueDirectoryFor(lockDirectory))).toEqual([]);
});

const abortedWaiterLeavesQueue = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  const holding = await acquireHostLock({ lockDirectory, holder: holder(scratch) });
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
  expect(await readdir(queueDirectoryFor(lockDirectory))).toEqual([]);
  await holding.release();
});

describe('the waiting queue', () => {
  test('grants the lock to waiters in the order they arrived', () => rethrow(grantsInArrivalOrder));

  test('a live earlier waiter keeps a later one from taking a free lock', () =>
    rethrow(livingEarlierWaiterBlocksLaterOnes));

  test('skips waiters whose process has exited or been recycled', () => rethrow(skipsDeadWaiter));

  test('a waiter that gives up leaves the queue', () => rethrow(abortedWaiterLeavesQueue));
});

const nestedStageReusesReservation = await inScratchDirectory(async (scratch) => {
  const { lockDirectory, directory } = scratch;
  const fixture = join(directory, 'nested.ts');
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
  // The outer run holds the lock; the stage it starts asks for the same lock and must not wait.
  const code = await runExclusively({
    lockDirectory,
    script: `'${process.execPath}' '${fixture}' '${lockDirectory}' 'exit 5'`,
    pollIntervalMs: 5,
    report: () => {},
  });
  expect(code).toBe(5);
  expect(await Bun.file(join(lockDirectory, ownerFileName)).exists()).toBe(false);
});

const exposesTokenOnlyToItsCommand = await inScratchDirectory(async (scratch) => {
  const { lockDirectory, directory } = scratch;
  const output = join(directory, 'token');
  await runExclusively({
    lockDirectory,
    script: `printf '%s' "$${heldLockTokenVariable}" > '${output}'`,
    report: () => {},
  });
  const token = await readFile(output, 'utf8');
  expect(token.length).toBeGreaterThan(0);
});

const staleReservationDoesNotBypassLock = await inScratchDirectory(async (scratch) => {
  const { lockDirectory } = scratch;
  const holding = await acquireHostLock({ lockDirectory, holder: holder(scratch) });
  const reports: string[] = [];
  const running = runExclusively({
    lockDirectory,
    script: 'exit 0',
    pollIntervalMs: 1,
    // A token inherited from a lock that has since been released names nothing now held.
    environment: { [heldLockTokenVariable]: 'not-the-holder' },
    report: (line) => reports.push(line),
  });
  while (reports.length === 0) await Bun.sleep(2);
  await holding.release();
  expect(await running).toBe(0);
});

describe('a reservation held across stages', () => {
  test('a stage started under the lock reuses it instead of queueing behind its own parent', () =>
    rethrow(nestedStageReusesReservation));

  test('the lock token reaches the command through the environment', () =>
    rethrow(exposesTokenOnlyToItsCommand));

  test('a token that does not match the current holder does not bypass the lock', () =>
    rethrow(staleReservationDoesNotBypassLock));
});

describe('withTurborepoDefaults', () => {
  const gibibyte = 1024 ** 3;

  test('shares one Turborepo cache inside the Git common directory', () => {
    const environment = withTurborepoDefaults({}, '/repository/.git', {
      totalMemoryBytes: 64 * gibibyte,
      processors: 10,
    });
    expect(environment['TURBO_CACHE_DIR']).toBe('/repository/.git/turbo-cache');
  });

  test('runs one task per 8 GiB of memory and per three processors, whichever is fewer, and at least one', () => {
    const concurrencyFor = (totalMemoryBytes: number, processors: number) =>
      withTurborepoDefaults({}, '/repository/.git', { totalMemoryBytes, processors })[
        'TURBO_CONCURRENCY'
      ];
    expect(concurrencyFor(32 * gibibyte, 12)).toBe('4');
    expect(concurrencyFor(64 * gibibyte, 10)).toBe('3');
    expect(concurrencyFor(16 * gibibyte, 12)).toBe('2');
    expect(concurrencyFor(4 * gibibyte, 10)).toBe('1');
    expect(concurrencyFor(256 * gibibyte, 2)).toBe('1');
  });

  test('gives a shared run half the concurrency, and at least one task', () => {
    const sharedConcurrencyFor = (totalMemoryBytes: number, processors: number) =>
      withTurborepoDefaults({}, '/repository/.git', { totalMemoryBytes, processors }, true)[
        'TURBO_CONCURRENCY'
      ];
    expect(sharedConcurrencyFor(32 * gibibyte, 12)).toBe('2');
    expect(sharedConcurrencyFor(64 * gibibyte, 24)).toBe('4');
    expect(sharedConcurrencyFor(16 * gibibyte, 12)).toBe('1');
    expect(sharedConcurrencyFor(4 * gibibyte, 2)).toBe('1');
  });

  test("keeps the caller's own cache directory and concurrency", () => {
    const environment = withTurborepoDefaults(
      { TURBO_CACHE_DIR: '/elsewhere', TURBO_CONCURRENCY: '1', PATH: '/bin' },
      '/repository/.git',
      { totalMemoryBytes: 64 * gibibyte, processors: 10 },
    );
    expect(environment).toEqual({
      TURBO_CACHE_DIR: '/elsewhere',
      TURBO_CONCURRENCY: '1',
      PATH: '/bin',
    });
  });
});

describe('withPreflight', () => {
  test('checks the install against the lockfile before the command runs', () => {
    expect(withPreflight('turbo run lint')).toBe('bun install --frozen-lockfile && turbo run lint');
  });
});
