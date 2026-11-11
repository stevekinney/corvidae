import type { Subprocess } from 'bun';
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { rejectionOf } from '../testing/testing/src/helpers/promise-outcome.ts';
import { waitUntil } from '../testing/testing/src/wait-until.ts';
import {
  acquireTestSlots,
  claimSlots,
  defaultPoolSize,
  describePool,
  heldSlotsTokenVariable,
  isHolderAlive,
  isTestWorkerCommand,
  poolSize,
  readProcessTable,
  requestedWorkers,
  runPooledBunTest,
  slotDirectory,
  testWorkersOf,
  withWorkerCount,
  type AcquireTestSlotsOptions,
  type ProcessEntry,
  type ProcessTable,
  type RecordedWorker,
  type SlotOwner,
} from './bun-test-pool.ts';
import { rootScriptEnvironment } from './environment-configuration.ts';
import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';
import { acquireHostLock, ownerFileName, type HostLockHolder } from './run-exclusively.ts';

/**
 * The pool's scenarios. Each owns a scratch pool directory, never the real Git common directory.
 * Liveness comes from an injected process table where the scenario is about the pool's logic, and
 * from the real one where it is about real processes; waiting is on state, through `onWait`,
 * `report` and `waitUntil`, and a waiter's poll yields a turn instead of sleeping. A scenario that
 * reads the real process table or starts a process runs once at module scope, where no per-test
 * clock applies, and its test rethrows what it recorded (COR-1392, COR-1507).
 */
const scratchDirectories: string[] = [];
const processGroups: number[] = [];

afterAll(async () => {
  for (const group of processGroups) killGroup(group);
  for (const directory of scratchDirectories) await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-test-slots-'));
  scratchDirectories.push(directory);
  return directory;
}

/** Runs one scenario against its own scratch directory and returns what it threw. */
function inScratchDirectory(body: (directory: string) => Promise<void>): Promise<unknown> {
  return outcomeOf(async () => {
    await body(await scratch());
  });
}

function holder(cwd: string, pid = process.pid): HostLockHolder {
  return { pid, command: 'test', cwd, acquiredAt: new Date(0).toISOString() };
}

/** A process table in which only this process is alive. */
const onlyThisProcess = (): ProcessTable =>
  new Map([[process.pid, { processGroup: process.pid, startedAt: 'this process' }]]);

/** A waiter's poll: one filesystem round trip, which lets every other waiter run, and no clock. */
const turn = async (): Promise<void> => {
  await stat(tmpdir());
};

const neverSleep = async (): Promise<void> => {
  throw new Error('the waiter waited');
};

function options(
  poolDirectory: string,
  size: number,
  slots: number,
  overrides: Partial<AcquireTestSlotsOptions> = {},
): AcquireTestSlotsOptions {
  return {
    poolDirectory,
    size,
    slots,
    holder: holder(poolDirectory),
    readProcessTable: onlyThisProcess,
    sleep: turn,
    ...overrides,
  };
}

async function heldSlots(poolDirectory: string): Promise<number> {
  const names = await readdir(poolDirectory).catch(() => [] as string[]);
  return names.filter((name) => /^slot-\d+$/.test(name)).length;
}

async function writeSlot(poolDirectory: string, index: number, contents: string): Promise<void> {
  await mkdir(slotDirectory(poolDirectory, index), { recursive: true });
  await writeFile(join(slotDirectory(poolDirectory, index), ownerFileName), contents);
}

function owner(poolDirectory: string, fields: Partial<SlotOwner>): string {
  return JSON.stringify({ ...holder(poolDirectory), token: 'other', slots: 1, ...fields });
}

function killGroup(processGroup: number): void {
  try {
    process.kill(-processGroup, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function isGroupAlive(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch {
    return false;
  }
}

async function exitedPid(): Promise<number> {
  const child = spawnWithHangGuard(['true']);
  await child.exited;
  return child.pid;
}

/** What a fixture's pooled run starts; by default a stand-in that lives until it is killed. */
type PooledRunFixture = {
  readonly bunTestArguments?: readonly string[];
  /** Null runs the real `bun test`. */
  readonly command?: readonly string[] | null;
  readonly cwd?: string;
  readonly size?: number;
};

/**
 * Starts a real pooled run in a wrapper process, and resolves once its slot record satisfies
 * `ready` (by default, once its process group is recorded).
 */
async function startPooledRun(
  poolDirectory: string,
  environment: Record<string, string | undefined> = process.env,
  run: PooledRunFixture = {},
  ready: (record: SlotOwner) => boolean = () => true,
): Promise<{ wrapper: Subprocess; processGroup: number; record: SlotOwner }> {
  const fixture = join(poolDirectory, '..', 'pooled-run.ts');
  await writeFile(
    fixture,
    `import { runPooledBunTest } from ${JSON.stringify(join(import.meta.dir, 'bun-test-pool.ts'))};
const run = JSON.parse(process.argv[3]);
process.exitCode = await runPooledBunTest({
  bunTestArguments: run.bunTestArguments ?? [],
  ...(run.command === null ? {} : { command: run.command ?? ['sh', '-c', 'exec tail -f /dev/null'] }),
  ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
  poolDirectory: process.argv[2],
  size: run.size ?? 1,
  pollIntervalMs: 5,
  report: () => {},
});
`,
  );
  const wrapper = spawnWithHangGuard(
    [process.execPath, fixture, poolDirectory, JSON.stringify(run)],
    { env: environment, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  let record: SlotOwner | undefined;
  await waitUntil(
    async () => {
      const contents = await readFile(
        join(slotDirectory(poolDirectory, 0), ownerFileName),
        'utf8',
      ).catch(() => '');
      record = contents === '' ? undefined : (JSON.parse(contents) as SlotOwner);
      return record?.processGroup !== undefined && ready(record);
    },
    { message: 'the pooled run recorded its process group' },
  );
  if (record?.processGroup === undefined) throw new Error('unreachable');
  processGroups.push(record.processGroup);
  return { wrapper, processGroup: record.processGroup, record };
}

const threeRunsShareAPoolOfEight = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  const first = await acquireTestSlots(options(pool, 8, 4));
  const second = await acquireTestSlots(options(pool, 8, 4));
  const { promise: waiting, resolve: markWaiting } = Promise.withResolvers<void>();
  let thirdHeld = false;
  const third = acquireTestSlots(options(pool, 8, 4, { onWait: () => markWaiting() })).then(
    (held) => {
      thirdHeld = true;
      return held;
    },
  );
  await waiting;
  expect(thirdHeld).toBe(false);
  expect(await heldSlots(pool)).toBe(8);
  await first.release();
  const held = await third;
  expect(await heldSlots(pool)).toBe(8);
  await Promise.all([second.release(), held.release()]);
  expect(await heldSlots(pool)).toBe(0);
});

const eightRunsNeverExceedThePool = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  const size = 5;
  let held = 0;
  let mostHeld = 0;
  const observed: number[] = [];
  await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const slots = 1 + (index % 4);
      const lease = await acquireTestSlots(options(pool, size, slots));
      held += slots;
      mostHeld = Math.max(mostHeld, held);
      observed.push(await heldSlots(pool));
      await turn();
      held -= slots;
      await lease.release();
    }),
  );
  expect(mostHeld).toBeLessThanOrEqual(size);
  expect(Math.max(...observed)).toBeLessThanOrEqual(size);
  expect(observed).toHaveLength(8);
  expect(await heldSlots(pool)).toBe(0);
});

const grantsInArrivalOrder = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  const order: string[] = [];
  const holding = await acquireTestSlots(options(pool, 4, 3));
  const waitingLines: Record<string, string[]> = { large: [], small: [] };
  const start = async (name: 'large' | 'small', slots: number) => {
    const { promise: waiting, resolve } = Promise.withResolvers<void>();
    const lease = acquireTestSlots(
      options(pool, 4, slots, {
        onWait: (line) => {
          waitingLines[name]?.push(line);
          resolve();
        },
      }),
    ).then((held) => {
      order.push(name);
      return held;
    });
    await waiting;
    // Wrapped, because an async function that returns a promise waits for it.
    return { lease };
  };
  const large = await start('large', 4);
  // One slot is free, but the small request arrived after the large one and must wait its turn.
  const small = await start('small', 1);
  expect(waitingLines['small']?.[0]).toStartWith('queued behind');
  expect(order).toEqual([]);
  await holding.release();
  const largeLease = await large.lease;
  await largeLease.release();
  const smallLease = await small.lease;
  await smallLease.release();
  expect(order).toEqual(['large', 'small']);
});

const reclaimsExitedHolder = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  await writeSlot(pool, 0, owner(pool, { pid: await exitedPid() }));
  const lease = await acquireTestSlots(options(pool, 1, 1, { sleep: neverSleep }));
  await lease.release();
});

const doesNotMistakeRecycledPid = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  await writeSlot(pool, 0, owner(pool, { pidStartedAt: 'Thu Jan  1 00:00:00 1970' }));
  const lease = await acquireTestSlots(
    options(pool, 1, 1, { sleep: neverSleep, readProcessTable }),
  );
  await lease.release();
});

const killedWrapperKeepsItsSlots = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  const { wrapper, processGroup } = await startPooledRun(pool);
  wrapper.kill('SIGKILL');
  await wrapper.exited;
  const controller = new AbortController();
  const blocked = rejectionOf(
    acquireTestSlots(
      options(pool, 1, 1, {
        readProcessTable,
        signal: controller.signal,
        onWait: () => controller.abort(),
      }),
    ),
  );
  expect(await blocked).toBeInstanceOf(Error);
  killGroup(processGroup);
  const lease = await acquireTestSlots(options(pool, 1, 1, { readProcessTable }));
  await lease.release();
});

const holderUnderAnotherZoneIsAlive = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  // `ps` prints start times in the caller's zone; the lanes run with and without `TZ=UTC`.
  const zone =
    rootScriptEnvironment()['TZ'] === 'Pacific/Kiritimati'
      ? 'Pacific/Pago_Pago'
      : 'Pacific/Kiritimati';
  const { processGroup } = await startPooledRun(pool, { ...process.env, TZ: zone });
  const controller = new AbortController();
  const blocked = rejectionOf(
    acquireTestSlots(
      options(pool, 1, 1, {
        readProcessTable,
        signal: controller.signal,
        onWait: () => controller.abort(),
      }),
    ),
  );
  expect(await blocked).toBeInstanceOf(Error);
  expect(await heldSlots(pool)).toBe(1);
  killGroup(processGroup);
});

const createsAMissingPoolDirectory = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'missing', 'pool');
  const lease = await acquireTestSlots(options(pool, 2, 2, { sleep: neverSleep }));
  expect(await heldSlots(pool)).toBe(2);
  await lease.release();
});

const treatsGarbageAsFreeSlots = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  await mkdir(join(pool, 'queue'), { recursive: true });
  await writeFile(slotDirectory(pool, 0), 'a stray file');
  await writeSlot(pool, 1, 'not json');
  await writeFile(join(pool, 'queue', 'stray.txt'), '');
  await writeFile(join(pool, 'queue', '0000000000000001-bad.json'), 'not json');
  const lease = await acquireTestSlots(options(pool, 2, 2, { sleep: neverSleep }));
  expect(lease.slots).toEqual([0, 1]);
  await lease.release();
  expect(await readdir(join(pool, 'queue'))).toEqual(['stray.txt']);
});

const returnsTheExitCodeAndReleases = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  const groupFile = join(directory, 'group');
  const code = await runPooledBunTest({
    bunTestArguments: [],
    command: ['sh', '-c', `sleep 30 & echo $$ > '${groupFile}'; exit 3`],
    poolDirectory: pool,
    size: 2,
    report: () => {},
  });
  expect(code).toBe(3);
  expect(isGroupAlive(Number(await readFile(groupFile, 'utf8')))).toBe(false);
  expect(await heldSlots(pool)).toBe(0);
});

const clampsARequestAboveThePool = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  const output = join(directory, 'output');
  const reports: string[] = [];
  const code = await runPooledBunTest({
    bunTestArguments: ['--parallel=8'],
    command: ['sh', '-c', `{ printf '%s\\n' "$@"; ls '${pool}'; } > '${output}'`, 'sh'],
    poolDirectory: pool,
    size: 4,
    report: (line) => reports.push(line),
  });
  expect(code).toBe(0);
  const written = await readFile(output, 'utf8');
  const lines = written.trim().split('\n');
  expect(lines[0]).toBe('--parallel=4');
  expect(lines.filter((line) => /^slot-\d+$/.test(line))).toHaveLength(4);
  expect(reports).toEqual(['bun-test-pool: running 4 workers, the size of the pool, not 8']);
});

const reusesItsParentsSlot = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  await writeSlot(pool, 0, owner(pool, { token: 'parent' }));
  const code = await runPooledBunTest({
    bunTestArguments: [],
    command: ['sh', '-c', 'exit 7'],
    environment: { [heldSlotsTokenVariable]: 'parent' },
    poolDirectory: pool,
    size: 1,
    readProcessTable: onlyThisProcess,
    report: () => {},
  });
  expect(code).toBe(7);
  const recorded = JSON.parse(await readFile(join(slotDirectory(pool, 0), ownerFileName), 'utf8'));
  expect(recorded.token).toBe('parent');
});

const staleTokenDoesNotBypassThePool = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  await writeSlot(pool, 0, owner(pool, { token: 'holder' }));
  const reports: string[] = [];
  const { promise: waiting, resolve: markWaiting } = Promise.withResolvers<void>();
  const running = runPooledBunTest({
    bunTestArguments: [],
    command: ['sh', '-c', 'exit 0'],
    environment: { [heldSlotsTokenVariable]: 'gone' },
    poolDirectory: pool,
    size: 1,
    pollIntervalMs: 1,
    readProcessTable: onlyThisProcess,
    report: (line) => {
      reports.push(line);
      markWaiting();
    },
  });
  await waiting;
  expect(reports[0]).toContain('waiting for 1 of 1 test slots');
  await rm(slotDirectory(pool, 0), { recursive: true });
  expect(await running).toBe(0);
});

const exportsItsTokenToTheTests = await inScratchDirectory(async (directory) => {
  const output = join(directory, 'token');
  await runPooledBunTest({
    bunTestArguments: [],
    command: ['sh', '-c', `printf '%s' "$${heldSlotsTokenVariable}" > '${output}'`],
    poolDirectory: join(directory, 'pool'),
    size: 1,
    report: () => {},
  });
  const token = await readFile(output, 'utf8');
  expect(token.length).toBeGreaterThan(0);
});

const runsWithoutASlotWhenThePoolIsUnusable = await inScratchDirectory(async (directory) => {
  const blocked = join(directory, 'a-file');
  await writeFile(blocked, '');
  const reports: string[] = [];
  const code = await runPooledBunTest({
    bunTestArguments: [],
    command: ['sh', '-c', 'exit 5'],
    poolDirectory: join(blocked, 'pool'),
    size: 1,
    report: (line) => reports.push(line),
  });
  expect(code).toBe(5);
  expect(reports.join('\n')).toContain('bun-test-pool: running without a test slot');
});

const pooledRunIgnoresTheHostLock = await inScratchDirectory(async (directory) => {
  const lock = await acquireHostLock({
    lockDirectory: join(directory, 'host-lock'),
    holder: holder(directory),
  });
  try {
    const code = await runPooledBunTest({
      bunTestArguments: [],
      command: ['sh', '-c', 'exit 0'],
      poolDirectory: join(directory, 'pool'),
      size: 1,
      report: () => {},
    });
    expect(code).toBe(0);
  } finally {
    await lock.release();
  }
});

const signalReachesTheTestGroup = {
  SIGTERM: await signalScenario('SIGTERM'),
  SIGINT: await signalScenario('SIGINT'),
};

function signalScenario(signal: 'SIGTERM' | 'SIGINT'): Promise<unknown> {
  return inScratchDirectory(async (directory) => {
    const pool = join(directory, 'pool');
    const { wrapper, processGroup } = await startPooledRun(pool);
    wrapper.kill(signal);
    await wrapper.exited;
    expect(isGroupAlive(processGroup)).toBe(false);
    expect(await heldSlots(pool)).toBe(0);
  });
}

const statusCommandExitsZero = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  const status = spawnWithHangGuard(
    [
      process.execPath,
      join(import.meta.dir, 'bun-test-pool.ts'),
      'status',
      '--pool',
      pool,
      '--size',
      '3',
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );
  const output = await new Response(status.stdout).text();
  expect(await status.exited).toBe(0);
  expect(output).toBe(`test slot pool ${pool}: 0 of 3 held, 3 free, 0 waiting\n`);
});

const workerCommand = '/opt/bun/bin/bun test --test-worker --isolate --timeout=240000';

/** This process plus `entries`, as a mutable table a signal recorder can remove a process from. */
function tableWith(
  entries: Record<number, Omit<ProcessEntry, 'processGroup'>>,
): Map<number, ProcessEntry> {
  const table = new Map(onlyThisProcess());
  for (const [pid, entry] of Object.entries(entries)) {
    table.set(Number(pid), { processGroup: Number(pid), ...entry });
  }
  return table;
}

/** An orphaned holder: its wrapper has exited and it recorded no group, only `worker`. */
async function writeOrphanedHolder(pool: string, worker: RecordedWorker): Promise<void> {
  await writeSlot(pool, 0, owner(pool, { pid: await exitedPid(), workers: [worker] }));
}

const orphanWorker: RecordedWorker = { pid: 4_000_001, startedAt: 'worker start' };

const reclaimerTerminatesOrphanedWorkers = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  await writeOrphanedHolder(pool, orphanWorker);
  const table = tableWith({
    [orphanWorker.pid]: { startedAt: orphanWorker.startedAt, command: workerCommand },
  });
  const signals: string[] = [];
  const lease = await acquireTestSlots(
    options(pool, 1, 1, {
      readProcessTable: () => table,
      signalProcess: (pid, signal) => {
        signals.push(`${pid} ${signal}`);
        table.delete(pid);
      },
      sleep: neverSleep,
    }),
  );
  expect(signals).toEqual([`${orphanWorker.pid} SIGTERM`]);
  await lease.release();
});

const recycledWorkerPidIsIgnored = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  await writeOrphanedHolder(pool, orphanWorker);
  const signals: string[] = [];
  const lease = await acquireTestSlots(
    options(pool, 1, 1, {
      readProcessTable: () =>
        tableWith({ [orphanWorker.pid]: { startedAt: 'a later start', command: workerCommand } }),
      signalProcess: (pid, signal) => signals.push(`${pid} ${signal}`),
      sleep: neverSleep,
    }),
  );
  expect(signals).toEqual([]);
  await lease.release();
});

const nonWorkerIsNeverSignalled = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  await writeOrphanedHolder(pool, orphanWorker);
  const signals: string[] = [];
  const controller = new AbortController();
  const blocked = rejectionOf(
    acquireTestSlots(
      options(pool, 1, 1, {
        readProcessTable: () =>
          tableWith({
            [orphanWorker.pid]: { startedAt: orphanWorker.startedAt, command: 'node server.js' },
          }),
        signalProcess: (pid, signal) => signals.push(`${pid} ${signal}`),
        signal: controller.signal,
        onWait: () => controller.abort(),
      }),
    ),
  );
  expect(await blocked).toBeInstanceOf(Error);
  expect(signals).toEqual([]);
  expect(await heldSlots(pool)).toBe(1);
});

const nestedRunClampsToItsParentsSlots = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  const output = join(directory, 'output');
  for (const index of [0, 1]) {
    await writeSlot(pool, index, owner(pool, { token: 'parent', slots: 2 }));
  }
  const reports: string[] = [];
  const code = await runPooledBunTest({
    bunTestArguments: ['--parallel=4', 'src'],
    command: ['sh', '-c', `printf '%s\\n' "$@" > '${output}'`, 'sh'],
    environment: { [heldSlotsTokenVariable]: 'parent' },
    poolDirectory: pool,
    size: 8,
    readProcessTable: onlyThisProcess,
    report: (line) => reports.push(line),
  });
  expect(code).toBe(0);
  expect(await readFile(output, 'utf8')).toBe('--parallel=2\nsrc\n');
  expect(reports).toEqual([
    'bun-test-pool: running 2 workers, the slots of the run it is nested in, not 4',
  ]);
  expect(await heldSlots(pool)).toBe(2);
});

/**
 * A leader with two workers that lead process groups of their own and outlive it once the wrapper
 * and then the leader are killed with SIGKILL, so only the workers recorded in the slot keep it
 * held; the next acquirer terminates them and reclaims the slots. The workers are stand-ins named
 * like Bun's (`bun test --test-worker`) rather than real `bun test --parallel` workers because
 * those outlive a killed leader on macOS only: on Linux Bun's workers exit with their parent, so
 * there is nothing to reclaim and a real run would leave no survivors to assert on.
 */
const killedRunLeavesNoWorkers = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  const worker = join(directory, 'bun');
  await writeFile(worker, '#!/bin/sh\nwhile true; do sleep 0.2; done\n', { mode: 0o755 });
  const leader = join(directory, 'leader.ts');
  await writeFile(
    leader,
    `import { spawn } from 'node:child_process';
for (let index = 0; index < 2; index += 1) {
  spawn(${JSON.stringify(worker)}, ['test', '--test-worker'], { detached: true, stdio: 'ignore' }).unref();
}
await new Promise(() => {});
`,
  );
  const { wrapper, processGroup, record } = await startPooledRun(
    pool,
    rootScriptEnvironment(),
    {
      bunTestArguments: ['--parallel=2'],
      command: [process.execPath, leader],
      cwd: directory,
      size: 2,
    },
    (candidate) => (candidate.workers?.length ?? 0) === 2,
  );
  const workers = record.workers ?? [];
  const survivors = () => {
    const table = readProcessTable();
    return workers.filter((worker) => table?.get(worker.pid)?.startedAt === worker.startedAt);
  };
  try {
    wrapper.kill('SIGKILL');
    await wrapper.exited;
    killGroup(processGroup);
    await waitUntil(() => !isGroupAlive(processGroup), {
      message: 'the bun test leader exited',
    });
    expect(survivors()).toHaveLength(2);
    const lease = await acquireTestSlots(options(pool, 2, 2, { readProcessTable }));
    expect(survivors()).toEqual([]);
    await lease.release();
    expect(await heldSlots(pool)).toBe(0);
  } finally {
    // Each worker leads its own group; only this run's, by pid and start time, are signalled.
    for (const worker of survivors()) killGroup(worker.pid);
  }
});

/**
 * The run's record write fails, and a stand-in `bun test --test-worker` still runs under the
 * leader. The run must go on tracking its workers and terminate them on exit. The process table
 * hook removes the run's slot directory at its first read after the slot is taken; the tracker
 * makes that read before the record write only when it starts first, so the write then fails. That
 * first read comes right after the leader starts, often before it has started the worker, so the
 * hook looks for the worker in that read and every later one, the same tables the tracker reads
 * (COR-2397). The leader waits for the worker to be seen, up to a bound, so a run that never tracks
 * it ends with the worker alive instead of hanging.
 */
const failedRecordStillTracksWorkers = await inScratchDirectory(async (directory) => {
  const pool = join(directory, 'pool');
  const worker = join(directory, 'bun');
  await writeFile(worker, '#!/bin/sh\nwhile true; do sleep 0.2; done\n', { mode: 0o755 });
  const seen = join(directory, 'seen');
  const tracked: number[] = [];
  const reports: string[] = [];
  let removed = false;
  const read = (): ProcessTable | undefined => {
    const table = readProcessTable();
    if (!removed) {
      if (!existsSync(join(slotDirectory(pool, 0), ownerFileName))) return table;
      rmSync(slotDirectory(pool, 0), { recursive: true, force: true });
      removed = true;
    }
    for (const [pid, entry] of table ?? []) {
      if (!entry.command?.includes(worker) || !isTestWorkerCommand(entry.command)) continue;
      if (!tracked.includes(pid)) tracked.push(pid);
      writeFileSync(seen, '');
    }
    return table;
  };
  const leader = `'${worker}' test --test-worker & i=0; while [ ! -e '${seen}' ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done`;
  try {
    const code = await runPooledBunTest({
      bunTestArguments: ['--parallel=1'],
      command: ['sh', '-c', leader, 'sh'],
      poolDirectory: pool,
      size: 1,
      readProcessTable: read,
      report: (line) => reports.push(line),
    });
    expect(code).toBe(0);
    expect(reports.join('\n')).toContain("could not record the command's process group");
    expect(tracked).toHaveLength(1);
    const table = readProcessTable();
    expect(tracked.filter((pid) => table?.has(pid))).toEqual([]);
  } finally {
    for (const pid of tracked) killGroup(pid);
  }
});

describe('the pool size', () => {
  test('sizes the pool from processors and memory, and honours the override', () => {
    const gibibytes = (count: number) => count * 1024 ** 3;
    expect(defaultPoolSize({ processors: 12, totalMemoryBytes: gibibytes(32) })).toBe(10);
    expect(defaultPoolSize({ processors: 4, totalMemoryBytes: gibibytes(16) })).toBe(4);
    expect(defaultPoolSize({ processors: 64, totalMemoryBytes: gibibytes(32) })).toBe(10);
    expect(defaultPoolSize({ processors: 2, totalMemoryBytes: gibibytes(4) })).toBe(4);
    const host = { processors: 12, totalMemoryBytes: gibibytes(32) };
    expect(poolSize({ CORVIDAE_TEST_SLOTS: '3' }, host)).toBe(3);
    expect(poolSize({ CORVIDAE_TEST_SLOTS: '0' }, host)).toBe(10);
    expect(poolSize({ CORVIDAE_TEST_SLOTS: 'many' }, host)).toBe(10);
  });

  test('counts workers from --parallel, bare --parallel, and its absence', () => {
    expect(requestedWorkers(['src'], 12)).toBe(1);
    expect(requestedWorkers(['--parallel=1', 'src'], 12)).toBe(1);
    expect(requestedWorkers(['--parallel=4', '--parallel-delay=5'], 12)).toBe(4);
    expect(requestedWorkers(['--parallel'], 12)).toBe(12);
    expect(withWorkerCount(['--parallel', '--parallel-delay=5', 'src'], 3)).toEqual([
      '--parallel=3',
      '--parallel-delay=5',
      'src',
    ]);
  });
});

describe('acquiring slots', () => {
  test('three runs of four workers share a pool of eight two at a time', () =>
    rethrow(threeRunsShareAPoolOfEight));

  test('eight concurrent runs never hold more than the pool', () =>
    rethrow(eightRunsNeverExceedThePool));

  test('grants slots in arrival order, so neither a large nor a small request starves', () =>
    rethrow(grantsInArrivalOrder));

  test('two claims racing for the same slots never both hold them', async () => {
    const pool = join(await scratch(), 'pool');
    await mkdir(pool);
    const claimant = (token: string): SlotOwner => ({ ...holder(pool), token, slots: 2 });
    const results = await Promise.all([
      claimSlots(pool, [0, 1, 2], 2, claimant('a')),
      claimSlots(pool, [0, 1, 2], 2, claimant('b')),
    ]);
    const winners = results.filter((taken) => taken !== undefined);
    expect(winners).toHaveLength(1);
    expect(await heldSlots(pool)).toBe(2);
  });
});

describe('reclaiming slots', () => {
  test('reclaims a slot whose holder has exited without waiting', () =>
    rethrow(reclaimsExitedHolder));

  test('does not mistake a recycled pid for a holder', () => rethrow(doesNotMistakeRecycledPid));

  test('a killed wrapper keeps its slots until its process group is gone, then frees them', () =>
    rethrow(killedWrapperKeepsItsSlots));

  test('a holder recorded under another time zone is still alive', () =>
    rethrow(holderUnderAnotherZoneIsAlive));

  test('a holder whose wrapper and group are gone is held while a recorded worker lives', () => {
    const worker = { pid: 4_000_002, startedAt: 'worker start' };
    const record: SlotOwner = {
      ...holder('/worktree', 4_000_003),
      processGroup: 4_000_004,
      token: 'run',
      slots: 1,
      workers: [worker],
    };
    const alive = tableWith({ [worker.pid]: { startedAt: worker.startedAt } });
    expect(isHolderAlive(record, alive)).toBe(true);
    const recycled = tableWith({ [worker.pid]: { startedAt: 'a later start' } });
    expect(isHolderAlive(record, recycled)).toBe(false);
    expect(isHolderAlive(record, onlyThisProcess())).toBe(false);
  });

  test("finds a leader's Bun test workers among its descendants, and only those", () => {
    const table = tableWith({
      10: { startedAt: 'leader', command: 'bun test --parallel=2' },
      11: { startedAt: 'a', parent: 10, command: workerCommand },
      12: { startedAt: 'b', parent: 10, command: 'sh -c helper' },
      13: { startedAt: 'c', parent: 12, command: workerCommand },
      14: { startedAt: 'd', parent: 99, command: workerCommand },
    });
    expect(testWorkersOf(10, table).toSorted((left, right) => left.pid - right.pid)).toEqual([
      { pid: 11, startedAt: 'a' },
      { pid: 13, startedAt: 'c' },
    ]);
  });

  test('the reclaimer terminates the recorded workers of an orphaned holder, then reclaims', () =>
    rethrow(reclaimerTerminatesOrphanedWorkers));

  test('a recorded worker pid with a different start time is ignored and never signalled', () =>
    rethrow(recycledWorkerPidIsIgnored));

  test('a recorded pid that is no longer a Bun test worker is never signalled', () =>
    rethrow(nonWorkerIsNeverSignalled));

  test('a killed run leaves no Bun test worker running and its slots free', () =>
    rethrow(killedRunLeavesNoWorkers));

  test('a failed record write still tracks the workers and terminates them on exit', () =>
    rethrow(failedRecordStillTracksWorkers));

  test('creates a missing pool directory', () => rethrow(createsAMissingPoolDirectory));

  test('treats garbage in the pool as free slots', () => rethrow(treatsGarbageAsFreeSlots));
});

describe('running a pooled bun test', () => {
  test('returns the exit code and releases the slots', () =>
    rethrow(returnsTheExitCodeAndReleases));

  test('clamps a request above the pool to the pool and passes the clamped worker count', () =>
    rethrow(clampsARequestAboveThePool));

  test('a run started under a held slot reuses it instead of waiting on its parent', () =>
    rethrow(reusesItsParentsSlot));

  test('a run nested in a holder of two slots runs at most two workers', () =>
    rethrow(nestedRunClampsToItsParentsSlots));

  test('a token naming no live holder does not bypass the pool', () =>
    rethrow(staleTokenDoesNotBypassThePool));

  test('exports its token to the tests it runs', () => rethrow(exportsItsTokenToTheTests));

  test('runs without a slot, with a warning, when the pool cannot be used', () =>
    rethrow(runsWithoutASlotWhenThePoolIsUnusable));

  test('a pooled run never waits on the host lock', () => rethrow(pooledRunIgnoresTheHostLock));

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`a signal to the wrapper reaches the test process group and releases its slots (${signal})`, () =>
      rethrow(signalReachesTheTestGroup[signal]));
  }
});

describe('the boundary of the pool', () => {
  test('tsc, svelte-check and Playwright never take test slots', async () => {
    const manifests = ['package.json'];
    for await (const path of new Bun.Glob(
      '{applications,components,packages,testing,internal,plugins}/*/package.json',
    ).scan({ cwd: join(import.meta.dir, '..') })) {
      manifests.push(path);
    }
    const offenders: string[] = [];
    let checked = 0;
    for (const manifest of manifests) {
      const parsed: { scripts?: Record<string, string> } = await Bun.file(
        join(import.meta.dir, '..', manifest),
      ).json();
      const scripts = parsed.scripts ?? {};
      for (const [name, command] of Object.entries(scripts)) {
        if (!/\b(?:tsc|svelte-check)\b|playwright test/.test(command)) continue;
        checked += 1;
        if (/bun-test(?:-junit|-selected|-pool)?\.ts/.test(command)) {
          offenders.push(`${manifest} ${name}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});

describe('the status of the pool', () => {
  test('prints holders and free slots', async () => {
    const pool = join(await scratch(), 'pool');
    const record = {
      pid: process.pid,
      cwd: '/worktrees/one',
      command: '--parallel=4 src',
      acquiredAt: new Date(10_000).toISOString(),
    };
    await writeSlot(pool, 0, owner(pool, { ...record, token: 'run', slots: 2 }));
    await writeSlot(pool, 1, owner(pool, { ...record, token: 'run', slots: 2 }));
    const lines = await describePool(pool, 5, onlyThisProcess(), 25_000);
    expect(lines).toEqual([
      `test slot pool ${pool}: 2 of 5 held, 3 free, 0 waiting`,
      `  pid ${process.pid} holds 2 slot(s) for 15s in /worktrees/one: --parallel=4 src`,
    ]);
  });

  test('the status command exits 0', () => rethrow(statusCommandExitsZero));
});
