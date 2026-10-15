/**
 * Process ownership of the static gate's runner on every exit path, with stand-in children.
 *
 * Each case runs the real runner as its own process over the good fixture, with a stand-in static
 * server and a stand-in test runner that each leave sleepers behind: one in the child's own process
 * group, and one detached into a group of its own that names the run directory, as Chromium does.
 * The case captures every descendant of the runner and their process groups, then has the stand-in
 * start two more sleepers after that capture, then ends the run one way or another and proves
 * every captured process, every late process, and every captured group is gone, while a sentinel
 * the test started outside the runner survives.
 *
 * "Gone" tolerates a zombie unless `PLAYGROUND_LIFECYCLE_REQUIRE_REAPED=1`, which the Linux
 * `docker run --init` recipe sets so captured processes must also have been reaped.
 */
import { outcomeOf, rethrow, SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readEnvironmentConfiguration } from '../src/environment-configuration.ts';
import { fetchWithin } from './static-playground-preflight.ts';
import {
  descendantProcesses,
  exitedWithin,
  interruptRunner,
  isZombie,
  ownedProcesses,
  parseProcessTable,
  ProcessOwner,
  type ProcessRow,
  readProcessTable,
  SAMPLE_INTERVAL_MILLISECONDS,
  signalTarget,
  waitUntil,
} from './static-playground-processes.ts';

const DRIVER = join(
  import.meta.dirname,
  'fixtures',
  'static-playground',
  'stand-ins',
  'lifecycle-driver.ts',
);
const requireReaped = readEnvironmentConfiguration().playgroundLifecycleRequireReaped === '1';

type RunningCase = {
  driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  record: string;
  output: string;
  sentinel: Bun.Subprocess;
  stdout: () => string;
  stderr: Promise<string>;
};

const cleanups: (() => Promise<void>)[] = [];

/** Every wait in these cases is bounded, so a stuck step fails the case with a named reason. */
const WAIT_MILLISECONDS = 4_000;

function waitFor(condition: () => boolean, description = 'a lifecycle condition'): Promise<void> {
  return waitUntil(condition, WAIT_MILLISECONDS, description);
}

async function driverExit(running: RunningCase): Promise<number> {
  const status = await exitedWithin(running.driver, WAIT_MILLISECONDS);
  if (status === undefined) throw new Error('the gate runner did not exit within the bound');
  return status;
}

async function readPid(record: string, label: string): Promise<number> {
  const path = join(record, `${label}.pid`);
  await waitFor(() => existsSync(path), path);
  // The writer appends a newline last, so a complete line means a complete PID.
  await waitFor(() => readFileSync(path, 'utf8').endsWith('\n'));
  return Number(readFileSync(path, 'utf8').trim());
}

async function startCase(
  mode: 'pass' | 'fail' | 'hang',
  extraArguments: string[] = [],
): Promise<RunningCase> {
  const record = await mkdtemp(join(tmpdir(), 'static-lifecycle-record-'));
  const output = await mkdtemp(join(tmpdir(), 'static-lifecycle-output-'));
  const sentinel = Bun.spawn(['/bin/sh', '-c', 'while :; do sleep 1; done'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
  });
  const driver = Bun.spawn(
    [
      process.execPath,
      DRIVER,
      '--mode',
      mode,
      '--record',
      record,
      '--output',
      output,
      ...extraArguments,
    ],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
    },
  );
  let stdout = '';
  void (async () => {
    for await (const chunk of driver.stdout) stdout += new TextDecoder().decode(chunk);
  })();
  cleanups.push(async () => {
    // A case that failed before its runner exited must not leave it, or what it owns, behind.
    if (driver.exitCode === null && driver.signalCode === null) {
      const runDirectory = /run directory (\S+)/.exec(stdout)?.[1];
      await interruptRunner(driver, runDirectory, { graceMilliseconds: 1_000 });
    }
    sentinel.kill('SIGKILL');
    await exitedWithin(sentinel, WAIT_MILLISECONDS);
    await rm(record, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  });
  return {
    driver,
    record,
    output,
    sentinel,
    stdout: () => stdout,
    stderr: new Response(driver.stderr).text(),
  };
}

type Capture = { pids: Set<number>; groups: Set<number>; runDirectory: string; origin: string };

/** Wait for the stand-ins, capture the runner's tree, then have the stand-in spawn late sleepers. */
async function captureAndSpawnLate(running: RunningCase): Promise<Capture> {
  await waitFor(() => existsSync(join(running.record, 'ready')));
  await readPid(running.record, 'runner-detached');
  await readPid(running.record, 'server-grandchild');
  const table = readProcessTable();
  const ownGroup = table.find((row) => row.pid === process.pid)!.pgid;
  const captured = descendantProcesses(running.driver.pid, table).filter(
    (row) => row.pgid !== ownGroup,
  );
  const pids = new Set(captured.map((row) => row.pid));
  const groups = new Set(captured.map((row) => row.pgid));
  expect(groups.size).toBeGreaterThanOrEqual(3);

  await writeFile(join(running.record, 'spawn-late'), '');
  pids.add(await readPid(running.record, 'late-grandchild'));
  pids.add(await readPid(running.record, 'late-detached'));
  for (const label of ['test-runner', 'server', 'runner-grandchild', 'runner-detached']) {
    pids.add(await readPid(running.record, label));
  }
  const runDirectory = /run directory (\S+)/.exec(running.stdout())![1]!;
  const origin = /at (http:\/\/127\.0\.0\.1:\d+)/.exec(running.stdout())![1]!;
  return { pids, groups, runDirectory, origin };
}

async function expectEverythingGone(running: RunningCase, capture: Capture): Promise<void> {
  const table = readProcessTable();
  const isGone = (row: ProcessRow | undefined) =>
    row === undefined || (!requireReaped && isZombie(row));
  const livingPids = [...capture.pids].filter(
    (pid) => !isGone(table.find((row) => row.pid === pid)),
  );
  const livingGroupMembers = table.filter((row) => capture.groups.has(row.pgid) && !isGone(row));
  expect(livingPids).toEqual([]);
  expect(livingGroupMembers).toEqual([]);
  expect(isGone(table.find((row) => row.pid === running.sentinel.pid))).toBe(false);
  expect(existsSync(capture.runDirectory)).toBe(false);
  const port = await fetchWithin(capture.origin, {}, 2_000).then(
    () => 'listening',
    () => 'closed',
  );
  expect(port).toBe('closed');
}

/**
 * Run one lifecycle scenario at module scope, where Bun applies no per-test timeout, and record
 * its outcome for the test that names it. Whatever `startCase` registered is torn down in the
 * scenario's own `finally`, because a hook cannot start or stop a process.
 */
function lifecycleOutcome(scenario: () => Promise<void>): Promise<unknown> {
  return outcomeOf(async () => {
    try {
      await scenario();
    } finally {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    }
  });
}

const normalExitCleansUp = await lifecycleOutcome(async () => {
  const running = await startCase('pass');
  const capture = await captureAndSpawnLate(running);
  await writeFile(join(running.record, 'proceed'), '');

  expect(await driverExit(running)).toBe(0);
  await expectEverythingGone(running, capture);
});

const testRunnerFailureCleansUp = await lifecycleOutcome(async () => {
  const running = await startCase('fail');
  const capture = await captureAndSpawnLate(running);
  await writeFile(join(running.record, 'proceed'), '');

  expect(await driverExit(running)).toBe(3);
  await expectEverythingGone(running, capture);
});

const signalOutcomes = new Map<string, unknown>();
for (const [signal, status] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  signalOutcomes.set(
    signal,
    await lifecycleOutcome(async () => {
      const running = await startCase('hang');
      const capture = await captureAndSpawnLate(running);
      running.driver.kill(signal);

      expect(await driverExit(running)).toBe(status);
      await expectEverythingGone(running, capture);
    }),
  );
}

const interruptDuringCleanupExits130 = await lifecycleOutcome(async () => {
  const running = await startCase('pass', ['--stubborn']);
  const capture = await captureAndSpawnLate(running);
  const stubborn = await readPid(running.record, 'stubborn');
  capture.pids.add(stubborn);
  await writeFile(join(running.record, 'proceed'), '');
  // The stubborn sleeper ignores SIGTERM, which holds cleanup in its grace period.
  await waitFor(() => running.stdout().includes('cleaning up owned processes'));
  running.driver.kill('SIGINT');
  // Let cleanup finish promptly rather than wait out the grace and escalate.
  process.kill(stubborn, 'SIGKILL');

  expect(await driverExit(running)).toBe(130);
  await expectEverythingGone(running, capture);
});

const unmarkedGrandchildIsKilled = await lifecycleOutcome(async () => {
  // The stand-in test runner starts a sleeper in a new process group with no run-directory
  // marker, then exits normally. Once it has exited the sleeper is reparented; only the group
  // the owner retained while the runner was alive still identifies it.
  const running = await startCase('pass', ['--unmarked-detached']);
  const capture = await captureAndSpawnLate(running);
  const unmarked = await readPid(running.record, 'unmarked-detached');
  capture.pids.add(unmarked);
  // Let the owner's periodic sample observe the sleeper while its parent still lives.
  await Bun.sleep(SAMPLE_INTERVAL_MILLISECONDS * 3);
  await writeFile(join(running.record, 'proceed'), '');

  expect(await driverExit(running)).toBe(0);
  await expectEverythingGone(running, capture);
});

const outsideInterruptLeavesNothing = await lifecycleOutcome(async () => {
  // What the real-Chromium check does when it fails early: interrupt the runner, let its cleanup
  // run, and kill anything still attributable. SIGKILL of the runner alone would leave the
  // server's and the test runner's own process groups running.
  const running = await startCase('hang');
  const capture = await captureAndSpawnLate(running);

  expect(await interruptRunner(running.driver, capture.runDirectory)).toEqual({
    survivors: [],
    runnerExited: true,
  });
  expect(running.driver.exitCode).toBe(130);
  await expectEverythingGone(running, capture);
});

const serverDeathIsDiagnosed = await lifecycleOutcome(async () => {
  const running = await startCase('hang');
  const capture = await captureAndSpawnLate(running);
  process.kill(await readPid(running.record, 'server'), 'SIGKILL');

  expect(await driverExit(running)).toBe(1);
  expect(await running.stderr).toContain(
    '[static-playground] static server exited unexpectedly with signal SIGKILL',
  );
  await expectEverythingGone(running, capture);
});

const cleanupRunsOnce = await lifecycleOutcome(async () => {
  const marker = await mkdtemp(join(tmpdir(), 'static-owner-'));
  const sent: [number, NodeJS.Signals][] = [];
  const owner = new ProcessOwner({
    marker,
    signal: (target, signal) => {
      sent.push([target, signal]);
      signalTarget(target, signal);
    },
  });
  const child = owner.spawn('sleeper', ['/bin/sh', '-c', 'while :; do sleep 1; done'], {
    cwd: marker,
    env: { PATH: '/usr/bin:/bin' },
  });

  const first = await owner.cleanup();
  const signalsAfterFirst = sent.length;
  const second = await owner.cleanup();

  expect(first.complete).toBe(true);
  expect(sent).toContainEqual([-child.subprocess.pid, 'SIGTERM']);
  expect(second).toBe(first);
  expect(sent).toHaveLength(signalsAfterFirst);
  await rm(marker, { recursive: true, force: true });
});

describe('static gate runner lifecycle with stand-in children', () => {
  it('cleans up after a normal exit and returns the test runner status', () =>
    rethrow(normalExitCleansUp));

  it('cleans up after a test-runner failure and returns its exit code', () =>
    rethrow(testRunnerFailureCleansUp));

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('cleans up after %s to the runner and exits %i', (signal) =>
    rethrow(signalOutcomes.get(signal)),
  );

  it('exits 128 + signal for a SIGINT that arrives during cleanup of a passing run', () =>
    rethrow(interruptDuringCleanupExits130));

  it('kills a detached, unmarked grandchild after its parent exits before cleanup', () =>
    rethrow(unmarkedGrandchildIsKilled));

  it('stops a runner from outside without orphaning its detached groups', () =>
    rethrow(outsideInterruptLeavesNothing));

  it('diagnoses static-server death during active test-runner work', () =>
    rethrow(serverDeathIsDiagnosed));
});

describe('process ownership', () => {
  const row = (pid: number, ppid: number, pgid: number, args = 'sleep 1'): ProcessRow => ({
    pid,
    ppid,
    pgid,
    state: 'S',
    args,
  });

  it('owns group members, marker-named processes, the groups they lead, and their descendants', () => {
    const table = [
      row(10, 1, 10),
      row(11, 10, 10),
      row(20, 11, 20, 'chrome --user-data-dir=/run/owned/profile'),
      row(21, 20, 20, 'chrome --type=renderer'),
      row(22, 21, 99),
      row(30, 1, 30, 'unrelated'),
      row(31, 1, 1, 'runner'),
    ];

    const { rows, groups } = ownedProcesses(
      table,
      { groups: new Set([10]), marker: '/run/owned' },
      new Set([31]),
    );

    expect(rows.map((owned) => owned.pid).toSorted((left, right) => left - right)).toEqual([
      10, 11, 20, 21, 22,
    ]);
    expect([...groups].toSorted((left, right) => left - right)).toEqual([10, 20]);
  });

  it('parses ps output with long arguments and zombie states', () => {
    expect(parseProcessTable('  12   1  12 Ss   /bin/sh -c a b\n  13  12  12 Z+   \n')).toEqual([
      { ...row(12, 1, 12, '/bin/sh -c a b'), state: 'Ss' },
      { ...row(13, 12, 12, ''), state: 'Z+' },
    ]);
  });

  it('cleans up once: a second call sends no signal and returns the first result', () =>
    rethrow(cleanupRunsOnce));
});
