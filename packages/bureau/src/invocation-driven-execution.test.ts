/**
 * COR-1437 — durable work does not depend on a long-lived process.
 *
 * Every invocation here is a fresh Bun process (see
 * `test/invocation-driven/`) that builds its runtime with manual background
 * tasks against one file-backed SQLite store in a per-test temporary
 * directory, does bounded work, shuts its runtime down, and exits on its own.
 * The test is the driver: it plays cron or a queue by spawning maintenance
 * invocations, and it owns a virtual clock persisted in the temporary
 * directory, which each invocation reads once at boot and passes as `getNow`
 * and `runMaintenance(now)`. No test waits for real time to pass: claims lapse
 * and timers come due because the driver advances the clock.
 *
 * Each invocation must exit by itself within `LEAK_DEADLINE_MS` of reporting
 * its work finished, with nothing on stderr. One that does not is killed and
 * fails the test (`expectCleanExit`).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  expectCleanExit,
  InvocationDriver,
  type InvocationEvent,
} from './test/invocation-driven/driver';
import {
  BLOCK_ACTIVITY_VARIABLE,
  CLAIM_TAKEOVER_ADVANCE_MS,
  releasePath,
  VIRTUAL_START,
  WAKEUP_MS,
  WEFT_SLEEP_MS,
  writeClock,
} from './test/invocation-driven/protocol';

const FIXTURES = join(import.meta.dir, 'test', 'invocation-driven');
const WEFT = join(FIXTURES, 'weft-invocation.ts');
const OPERATIVE = join(FIXTURES, 'operative-invocation.ts');
const BUREAU = join(FIXTURES, 'bureau-invocation.ts');

const TIMEOUT_MS = 120_000;

interface TimelineEntry {
  readonly step: number;
  readonly label: string;
  readonly status: string;
  readonly output: string | null;
}

interface WorkflowReport {
  readonly status: string | null;
  readonly result: unknown;
  readonly timeline: readonly TimelineEntry[];
  readonly checkpointEventSteps: readonly number[];
  readonly checkpointSteps: readonly number[];
}

function workflowOf(finished: InvocationEvent): WorkflowReport {
  return finished['workflow'] as WorkflowReport;
}

let directory: string | undefined;
let driver: InvocationDriver | undefined;

function setUp(): { directory: string; driver: InvocationDriver } {
  directory = mkdtempSync(join(tmpdir(), 'corvidae-invocation-driven-'));
  driver = new InvocationDriver(directory);
  writeClock(directory, VIRTUAL_START);
  return { directory, driver };
}

afterEach(async () => {
  await driver?.killAll();
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  driver = undefined;
  directory = undefined;
});

/** Runs one invocation to completion and returns its `finished` report. */
async function invoke(
  entry: string,
  command: string,
  label: string,
  environment?: Record<string, string>,
): Promise<InvocationEvent> {
  if (driver === undefined) throw new Error('setUp() was not called');
  return expectCleanExit(driver.spawn(entry, command, label, environment));
}

/**
 * The persisted step history never records one step twice: the checkpoint
 * steps run 1..n without a gap or repeat, and so does the event log, which
 * appends one `workflow:checkpoint` record per commit.
 */
function expectEachStepCommittedOnce(workflow: WorkflowReport): void {
  const expected = workflow.checkpointSteps.map((_, index) => index + 1);
  expect(workflow.checkpointSteps).toEqual(expected);
  expect(workflow.checkpointEventSteps).toEqual(expected);
  expect(workflow.timeline.map((entry) => entry.step)).toEqual(expected);
}

function completedEntries(workflow: WorkflowReport, label: string): TimelineEntry[] {
  return workflow.timeline.filter((entry) => entry.label === label && entry.status === 'completed');
}

describe('a Weft workflow driven only by fresh invocations', () => {
  it(
    'reaches its terminal result through start, runMaintenance(now), and a result read',
    async () => {
      const { directory } = setUp();

      const started = workflowOf(await invoke(WEFT, 'start', 'start'));
      expect(started.status).toBe('running');
      expect(started.timeline.map((entry) => [entry.label, entry.status])).toEqual([
        ['charge', 'completed'],
        ['sleep', 'running'],
      ]);

      writeClock(directory, VIRTUAL_START + WEFT_SLEEP_MS);
      const due = await invoke(WEFT, 'maintain', 'due');
      expect(due['settled']).toBe('terminal');

      const read = workflowOf(await invoke(WEFT, 'read', 'read'));
      expect(read.status).toBe('completed');
      expect(read.result).toBe('charged order-1 in start; finished order-1 in due');
      expect(read.timeline.map((entry) => [entry.label, entry.status])).toEqual([
        ['charge', 'completed'],
        ['sleep', 'running'],
        ['sleep', 'completed'],
        ['finish', 'completed'],
      ]);
      expectEachStepCommittedOnce(read);
    },
    TIMEOUT_MS,
  );

  it(
    'never lets two overlapping invocations both commit a step',
    async () => {
      const { directory } = setUp();
      await invoke(WEFT, 'start', 'start');
      writeClock(directory, VIRTUAL_START + WEFT_SLEEP_MS);

      // Invocation A fires the timer and is held inside `finish`, holding the
      // workflow's claim. Invocation B wakes at the same moment and does the
      // same maintenance against the same workflow while A is mid-step.
      if (driver === undefined) throw new Error('setUp() was not called');
      const a = driver.spawn(WEFT, 'maintain', 'a', { [BLOCK_ACTIVITY_VARIABLE]: 'finish' });
      await Promise.all([a.waitFor('activity-started'), a.waitFor('maintained')]);
      const b = await invoke(WEFT, 'maintain', 'b');
      expect(b['settled']).toBe('held-elsewhere');
      expect(completedEntries(workflowOf(b), 'finish')).toEqual([]);

      writeFileSync(releasePath(directory, 'a'), '');
      const finishedA = await expectCleanExit(a);
      expect(finishedA['settled']).toBe('terminal');

      const read = workflowOf(await invoke(WEFT, 'read', 'read'));
      expect(read.status).toBe('completed');
      expectEachStepCommittedOnce(read);
      expect(completedEntries(read, 'finish').map((entry) => entry.output)).toEqual([
        '"finished order-1 in a"',
      ]);
      expect(JSON.stringify(read)).not.toContain('in b');
    },
    TIMEOUT_MS,
  );

  it(
    'completes with exactly one committed result after an invocation is SIGKILLed mid-activity',
    async () => {
      const { directory } = setUp();
      await invoke(WEFT, 'start', 'start');
      const dueAt = VIRTUAL_START + WEFT_SLEEP_MS;
      writeClock(directory, dueAt);

      if (driver === undefined) throw new Error('setUp() was not called');
      const killed = driver.spawn(WEFT, 'maintain', 'killed', {
        [BLOCK_ACTIVITY_VARIABLE]: 'finish',
      });
      await Promise.all([killed.waitFor('activity-started'), killed.waitFor('maintained')]);
      killed.kill('SIGKILL');
      const killedOutcome = await killed.outcome();
      expect(killedOutcome.signalCode).toBe('SIGKILL');
      expect(killedOutcome.events.map((event) => event.event)).not.toContain('finished');

      // The dead invocation's claim is still live on the virtual clock, so a
      // wake-up at the same moment leaves the workflow alone.
      const fenced = await invoke(WEFT, 'maintain', 'fenced');
      expect(fenced['settled']).toBe('held-elsewhere');
      expect(completedEntries(workflowOf(fenced), 'finish')).toEqual([]);

      writeClock(directory, dueAt + CLAIM_TAKEOVER_ADVANCE_MS);
      const successor = await invoke(WEFT, 'maintain', 'successor');
      expect(successor['settled']).toBe('terminal');

      const read = workflowOf(await invoke(WEFT, 'read', 'read'));
      expect(read.status).toBe('completed');
      expect(read.result).toBe('charged order-1 in start; finished order-1 in successor');
      expectEachStepCommittedOnce(read);
      expect(completedEntries(read, 'finish').map((entry) => entry.output)).toEqual([
        '"finished order-1 in successor"',
      ]);
      expect(JSON.stringify(read)).not.toContain('in killed');
    },
    TIMEOUT_MS,
  );
});

interface RunReport {
  readonly status: string | null;
  readonly content: string | null;
  readonly steps: readonly number[];
  readonly generateCalls: readonly number[];
}

function runOf(finished: InvocationEvent): RunReport {
  return finished['run'] as RunReport;
}

describe('an Operative durable run driven only by fresh invocations', () => {
  it(
    'parks on a wakeup in one invocation and completes its scripted continuation in the next',
    async () => {
      const { directory } = setUp();

      const started = await invoke(OPERATIVE, 'start', 'start');
      expect(started['settled']).toBe('parked');
      expect(runOf(started)).toEqual({
        status: 'running',
        content: null,
        steps: [0],
        generateCalls: [0],
      });

      writeClock(directory, VIRTUAL_START + WAKEUP_MS);
      const woken = await invoke(OPERATIVE, 'maintain', 'wake');
      expect(woken['settled']).toBe('terminal');
      expect(runOf(woken).generateCalls).toEqual([1]);

      expect(runOf(await invoke(OPERATIVE, 'read', 'read'))).toEqual({
        status: 'completed',
        content: 'woke in wake',
        steps: [0, 1],
        generateCalls: [],
      });
    },
    TIMEOUT_MS,
  );
});

interface BureauState {
  readonly parent: { readonly status: string | null; readonly content: unknown } | null;
  readonly child: { readonly status: string; readonly content: unknown } | null;
}

function bureauStateOf(finished: InvocationEvent): BureauState {
  return finished['beforeShutdown'] as BureauState;
}

/**
 * Bureau's limit. A Bureau invocation can only exit on its own through
 * `bureau.shutdown()`, and shutdown's default `'abort'` policy cancels every
 * active run, including a parent durably parked on a timer, so the next
 * invocation inherits a cancelled run instead of a parked one. `'drain'`
 * leaves the run recoverable but cannot finish shutting down while it is
 * parked. Bureau's durable engine schedules its timers on the wall clock (it
 * takes no `getNow`), so the virtual clock for these invocations starts at the
 * wall time; only `runDurableMaintenance(now)` reads it.
 */
describe('a Bureau parent with one child across fresh invocations', () => {
  it(
    'cannot hand a parked run to the next invocation: shutting down to exit cancels it',
    async () => {
      const { directory } = setUp();
      const startedAt = Date.now();
      writeClock(directory, startedAt);

      const started = await invoke(BUREAU, 'start', 'start');
      expect(started['shutdown']).toEqual({ policy: 'abort', unresolved: 0 });
      expect(bureauStateOf(started)).toEqual({
        parent: { status: 'running', content: null },
        child: { status: 'completed', content: 'child done in start' },
      });

      expect(bureauStateOf(await invoke(BUREAU, 'read', 'read'))).toEqual({
        parent: { status: 'cancelled', content: null },
        child: { status: 'completed', content: 'child done in start' },
      });

      writeClock(directory, startedAt + 2 * WAKEUP_MS);
      const woken = await invoke(BUREAU, 'maintain', 'wake');
      expect(woken['parentGenerateSteps']).toEqual([]);
      expect(bureauStateOf(woken).parent).toEqual({ status: 'cancelled', content: null });
    },
    TIMEOUT_MS,
  );

  it(
    'completes the same run when the first invocation is killed instead of shut down',
    async () => {
      const { directory } = setUp();
      const startedAt = Date.now();
      writeClock(directory, startedAt);
      if (driver === undefined) throw new Error('setUp() was not called');

      // `'drain'` leaves the parked parent recoverable but reports it unresolved;
      // the driver then kills the invocation, as a platform would reclaim it.
      const draining = driver.spawn(BUREAU, 'start-drain', 'start');
      const drained = await draining.waitFor('finished');
      expect(drained['shutdown']).toEqual({ policy: 'drain', unresolved: expect.any(Number) });
      expect((drained['shutdown'] as { unresolved: number }).unresolved).toBeGreaterThan(0);
      expect(bureauStateOf(drained).parent).toEqual({ status: 'running', content: null });
      draining.kill('SIGKILL');
      const drainingOutcome = await draining.outcome();
      expect(drainingOutcome.signalCode).toBe('SIGKILL');

      writeClock(directory, startedAt + 2 * WAKEUP_MS);
      const woken = await invoke(BUREAU, 'maintain', 'wake');
      expect(woken['parentGenerateSteps']).toEqual([1]);
      expect(bureauStateOf(woken)).toEqual({
        parent: { status: 'completed', content: 'parent woke in wake' },
        child: { status: 'completed', content: 'child done in start' },
      });
    },
    TIMEOUT_MS,
  );
});
