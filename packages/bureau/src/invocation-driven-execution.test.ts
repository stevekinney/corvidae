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
 *
 * Booting a fresh process per invocation cannot fit Bun's per-test clock on a
 * loaded host, so each scenario runs once at module scope through
 * `settleScenario`, one after another, and its test reports how it went
 * (`expectScenarioPassed`), as the process-crash suites do.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  expectScenarioPassed,
  type ScenarioOutcome,
  type ScenarioScope,
  settleScenario,
} from './test/hoisted-scenario';
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

/** Only a genuine hang trips this; no wait in a scenario is bounded by it. */
const HANG_GUARD_MILLISECONDS = 120_000;

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

interface Scenario {
  readonly directory: string;
  readonly driver: InvocationDriver;
  /** Runs one invocation to completion and returns its `finished` report. */
  readonly invoke: (
    entry: string,
    command: string,
    label: string,
    environment?: Record<string, string>,
  ) => Promise<InvocationEvent>;
}

/**
 * Runs `body` against a fresh temporary directory, holding the shared store
 * and the virtual clock, and reaps every invocation and the directory
 * afterwards, or as soon as the hang guard fires.
 */
function scenario(body: (scenario: Scenario) => Promise<void>): Promise<ScenarioOutcome> {
  return settleScenario(async (scope: ScenarioScope) => {
    const directory = mkdtempSync(join(tmpdir(), 'corvidae-invocation-driven-'));
    const driver = new InvocationDriver(directory);
    const release = async (): Promise<void> => {
      await driver.killAll();
      rmSync(directory, { recursive: true, force: true });
    };
    scope.onHang(release);
    writeClock(directory, VIRTUAL_START);
    try {
      await body({
        directory,
        driver,
        invoke: (entry, command, label, environment) =>
          expectCleanExit(driver.spawn(entry, command, label, environment)),
      });
    } finally {
      await release();
    }
  }, HANG_GUARD_MILLISECONDS);
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

const weftTerminal = await scenario(async ({ directory, invoke }) => {
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
});

const weftOverlap = await scenario(async ({ directory, driver, invoke }) => {
  await invoke(WEFT, 'start', 'start');
  writeClock(directory, VIRTUAL_START + WEFT_SLEEP_MS);

  // Invocation A fires the timer and is held inside `finish`, holding the
  // workflow's claim. Invocation B wakes at the same moment and does the
  // same maintenance against the same workflow while A is mid-step.
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
});

const weftKilled = await scenario(async ({ directory, driver, invoke }) => {
  await invoke(WEFT, 'start', 'start');
  const dueAt = VIRTUAL_START + WEFT_SLEEP_MS;
  writeClock(directory, dueAt);

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
});

describe('a Weft workflow driven only by fresh invocations', () => {
  it('reaches its terminal result through start, runMaintenance(now), and a result read', () => {
    expectScenarioPassed(weftTerminal);
  });

  it('never lets two overlapping invocations both commit a step', () => {
    expectScenarioPassed(weftOverlap);
  });

  it('completes with exactly one committed result after an invocation is SIGKILLed mid-activity', () => {
    expectScenarioPassed(weftKilled);
  });
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

const operativeParked = await scenario(async ({ directory, invoke }) => {
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
});

describe('an Operative durable run driven only by fresh invocations', () => {
  it('parks on a wakeup in one invocation and completes its scripted continuation in the next', () => {
    expectScenarioPassed(operativeParked);
  });
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
 * invocation inherits a cancelled run instead of a parked one. Bureau's
 * durable engine schedules its timers on the wall clock (it takes no
 * `getNow`), so the virtual clock for these invocations starts at the wall
 * time; only `runDurableMaintenance(now)` reads it.
 */
const bureauCancelled = await scenario(async ({ directory, invoke }) => {
  const startedAt = Date.now();
  writeClock(directory, startedAt);

  const started = await invoke(BUREAU, 'start', 'start');
  expect(started['diagnostics']).toEqual([]);
  expect(started['shutdown']).toEqual({ policy: 'abort', unresolved: 0 });
  expect(bureauStateOf(started)).toEqual({
    parent: { status: 'running', content: null },
    child: { status: 'completed', content: 'child done in start' },
  });

  const read = await invoke(BUREAU, 'read', 'read');
  expect(read['diagnostics']).toEqual([]);
  expect(bureauStateOf(read)).toEqual({
    parent: { status: 'cancelled', content: null },
    child: { status: 'completed', content: 'child done in start' },
  });

  writeClock(directory, startedAt + 2 * WAKEUP_MS);
  const woken = await invoke(BUREAU, 'maintain', 'wake');
  expect(woken['diagnostics']).toEqual([]);
  expect(woken['parentGenerateSteps']).toEqual([]);
  expect(bureauStateOf(woken).parent).toEqual({ status: 'cancelled', content: null });
});

describe('a Bureau parent with one child across fresh invocations', () => {
  it('cannot hand a parked run to the next invocation: shutting down to exit cancels it', () => {
    expectScenarioPassed(bureauCancelled);
  });
});
