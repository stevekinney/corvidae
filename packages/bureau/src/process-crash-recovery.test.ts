/**
 * COR-1390 — a durable run survives the real death of the process that owned
 * it, recovers in exactly one of two racing successors, and keeps its event
 * streams continuous.
 *
 * A child process runs a durable Bureau under `workflow-lease` ownership,
 * commits step 0, records what it observed, and SIGKILLs itself. This test
 * then boots two fresh Bureaus over the same storage at once: B in its own
 * process and C in a second child, so no process holds two handles on the
 * store (COR-1795).
 *
 * The one real-time wait is the claim-lapse wait: Weft's claim clock is not
 * injectable through `createRunEngine`, so it is derived from the claim TTL
 * exactly as `create-run-engine-crash-and-adopt.test.ts` does. Every other
 * wait is `child.exited`, a marker file, or a condition poll (`waitUntil`,
 * which falls back to a tiny real delay, because LMDB's completion callbacks
 * starve under a zero-delay macrotask loop; see
 * `event-history-run-ownership-recovery-lmdb.test.ts`).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import type { Subprocess } from 'bun';
import { describe, expect, it } from 'bun:test';

import { expectScenarioPassed, type ScenarioScope, settleScenario } from './test/hoisted-scenario';
import { unexpectedChildStderr } from './test/child-stderr';
import {
  RACER_GO_FILE,
  RACER_READY_FILE,
  RACER_REPORT_FILE,
  type Racer,
  type RacerReport,
  settleRacer,
  startRacer,
} from './test/process-crash-racer';
import {
  createLmdbStorageFixture,
  createSqliteStorageFixture,
  type PersistentBureauStorageFixture,
} from './test/storage-fixtures';
import { readChildJson } from './test/child-output-file';

const CHILD = join(import.meta.dir, 'test', 'process-crash-child.ts');

/** Must match the constant in `test/process-crash-work-integrity-fixtures.ts`. */
const CLAIM_TTL_MS = 200;
const runtime = createDefaultRuntimeServices();
/**
 * A relaunched child still running this long after it started is killed and
 * reported as stuck. The relaunch scenario's hang guard is twice this, so the
 * crash phase before it never lets the guard fire first.
 */
const RELAUNCH_DEADLINE_MS = 90_000;

interface CrashMarker {
  readonly runId: string;
  readonly sessionId: string;
  readonly maxAuditSequence: number;
  readonly sessionCursor: string;
  readonly sessionLastSequence: number;
}

function stepIndexOf(detail: unknown): number {
  const step = (detail as { step?: unknown } | null)?.step;
  if (typeof step !== 'number') {
    throw new Error(`step.completed detail carries no numeric step: ${JSON.stringify(detail)}`);
  }
  return step;
}

/**
 * The SIGKILLed child and the claim-lapse wait are real time and real processes, and the recovery
 * that follows boots durable engines over the child's store. None of that fits a per-test clock on
 * a loaded host, so each backend's scenario runs whole, once, at module scope (see
 * `test/hoisted-scenario.ts`); a failed assertion is captured there and rethrown by its test.
 */
async function recoveryScenario(backend: Backend, scope: ScenarioScope): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `corvidae-process-crash-${backend}-`));
  const storagePath = join(directory, 'bureau');
  const markerPath = join(directory, 'marker.json');
  const children: Subprocess<'ignore', 'ignore', 'pipe'>[] = [];
  let b: Racer | undefined;
  // B's fixture on the child's path, opened only once the crashed child is gone. C opens its own
  // handle in its own process.
  const storageFixture: PersistentBureauStorageFixture =
    backend === 'lmdb'
      ? createLmdbStorageFixture({ path: storagePath })
      : createSqliteStorageFixture({ path: storagePath });
  const spawnChild = (scenario: string): Subprocess<'ignore', 'ignore', 'pipe'> => {
    const child = spawnWithHangGuard(['bun', CHILD, scenario, backend, storagePath, markerPath], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    children.push(child);
    return child;
  };
  const stopChildren = (): void => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  };
  // A hung scenario never reaches its `finally`, so what it owns is released from here.
  scope.onHang(async () => {
    stopChildren();
    await b?.bureau.shutdown();
    await storageFixture.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  try {
    // Premise: the child died from SIGKILL and left its marker.
    const crashed = spawnChild('park-after-step-0');
    await crashed.exited;
    const crashedAt = runtime.clock.now();
    const stderr = await new Response(crashed.stderr).text();
    expect(crashed.signalCode ?? stderr).toBe('SIGKILL');
    expect(existsSync(markerPath)).toBe(true);
    const marker = readChildJson<CrashMarker>(markerPath);
    expect(typeof marker.maxAuditSequence).toBe('number');
    expect(typeof marker.sessionLastSequence).toBe('number');

    // C starts its process while the dead holder's claim lapses on Weft's own wall clock.
    const c = spawnChild('race-recover');
    const cStderr = new Response(c.stderr).text();
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10));
    await waitUntil(() => existsSync(join(directory, RACER_READY_FILE)) || c.exitCode !== null, {
      message: 'the racing child to open the store',
    });
    expect(c.exitCode).toBeNull();

    // Both racers boot at once.
    writeFileSync(join(directory, RACER_GO_FILE), '', 'utf8');
    b = await startRacer(storageFixture.storage);
    const bReport = await settleRacer(b, marker.runId);
    await c.exited;
    expect({
      exitCode: c.exitCode,
      unexpectedStderr: unexpectedChildStderr(await cStderr),
    }).toEqual({ exitCode: 0, unexpectedStderr: '' });
    const cReport = readChildJson<RacerReport>(join(directory, RACER_REPORT_FILE));

    for (const report of [bReport, cReport]) {
      // One assertion, so a partial recovery prints the failures that made it partial.
      expect({ outcome: report.recoveryOutcome, failures: report.perRunFailures }).toEqual({
        outcome: 'clean',
        failures: [],
      });
      expect(report.durableStatus).toBe('completed');
    }

    // Recovery: exactly one racer completes the run locally.
    expect([bReport, cReport].filter((report) => report.completedLocally)).toHaveLength(1);

    // Fencing: the post-crash step ran once across both racers; step 0 never reran.
    expect(bReport.stepsAtOrAfterOne + cReport.stepsAtOrAfterOne).toBe(1);
    expect(bReport.stepZeroCalls + cReport.stepZeroCalls).toBe(0);

    // C has exited, so B reads everything the winner committed from the store.
    const reader = b;
    const asOwner = await reader.bureau.tasks.events(marker.runId, { principal: 'alice' });
    if ('outcome' in asOwner) {
      throw new Error(`expected a page for alice, got ${JSON.stringify(asOwner)}`);
    }
    const kinds = asOwner.events.map((event) => event.kind);
    expect(kinds.filter((kind) => kind === 'run.completed')).toHaveLength(1);
    expect(kinds).not.toContain('run.error');
    expect(kinds).not.toContain('run.aborted');
    expect(await reader.bureau.tasks.events(marker.runId, { principal: 'mallory' })).toEqual({
      outcome: 'not-found',
    });

    const auditTrail = reader.bureau.internals.auditTrail;
    if (auditTrail === undefined) throw new Error('the bureau has no audit trail');

    // Continuity: audit sequence numbers are never reused.
    const records = await auditTrail.query({ runId: marker.runId });
    const sequences = records.map((record) => record.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(typeof record.sequence).toBe('number');
      // Every record above the marker was written after the crash, and none below it was.
      expect((record.sequence as number) > marker.maxAuditSequence).toBe(
        record.timestampMs > crashedAt,
      );
    }
    expect(
      records.filter((record) => (record.sequence as number) > marker.maxAuditSequence).length,
    ).toBeGreaterThan(0);

    // Continuity: no duplicate step record.
    const stepRecords = await auditTrail.query({
      runId: marker.runId,
      type: 'step.completed',
    });
    const indices = stepRecords.map((record) => stepIndexOf(record.detail));
    expect(indices.length).toBeGreaterThanOrEqual(2);
    expect(indices).toEqual(indices.map((_, position) => position));

    // Continuity: the pre-crash cursor still resumes without a gap.
    const resumed = await reader.bureau.contexts.events(marker.sessionId, {
      since: marker.sessionCursor,
    });
    if ('outcome' in resumed) {
      throw new Error(`expected a resumable page, got ${JSON.stringify(resumed)}`);
    }
    expect(resumed.events.length).toBeGreaterThan(0);
    let previous = marker.sessionLastSequence;
    for (const event of resumed.events) {
      expect(event.sequence).toBeGreaterThan(previous);
      previous = event.sequence;
    }
  } finally {
    stopChildren();
    await Promise.all(children.map((child) => child.exited));
    const shutdown = await b?.bureau.shutdown();
    await storageFixture.dispose();
    rmSync(directory, { recursive: true, force: true });
    if (shutdown !== undefined) expect(shutdown.unresolved).toBe(0);
  }
}

type Backend = 'sqlite' | 'lmdb';
// The hang guard is the per-test timeout these tests carried before they were hoisted. It only
// stops a genuine hang; every wait for a state change is by event (`waitForBureauState`).
const HANG_GUARD_MILLISECONDS = 120_000;
const outcomes = {
  sqlite: await settleScenario(
    (scope) => recoveryScenario('sqlite', scope),
    HANG_GUARD_MILLISECONDS,
  ),
  lmdb: await settleScenario((scope) => recoveryScenario('lmdb', scope), HANG_GUARD_MILLISECONDS),
};

describe.each(['sqlite', 'lmdb'] as const)('process crash recovery over %s', (backend) => {
  it('recovers in exactly one racer, fences the other, and keeps event streams continuous', () => {
    expectScenarioPassed(outcomes[backend]);
  });
});

interface RelaunchMarker {
  readonly runId: string;
  readonly recoveryOutcome?: string;
  readonly durableStatus?: string;
  readonly runStatus?: string;
  readonly stepZeroCalls: number;
  readonly laterStepCalls: number;
}

/**
 * COR-1439 — the supervisor shape: the process dies from SIGKILL mid-run, and
 * a relaunched process (not an in-test Bureau) recovers the durable run to its
 * terminal result. The relaunched child waits for the dead holder's claim to
 * lapse itself, by polling and driving durable maintenance, so this scenario
 * never sleeps. Like the racer scenario it boots real processes, so it runs at
 * module scope and its test reports the outcome.
 */
async function relaunchScenario(backend: Backend, scope: ScenarioScope): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `corvidae-process-relaunch-${backend}-`));
  const storagePath = join(directory, 'bureau');
  const markerPath = join(directory, 'marker.json');
  const children: Subprocess[] = [];
  const stopChildren = (): void => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  };
  scope.onHang(() => {
    stopChildren();
    rmSync(directory, { recursive: true, force: true });
  });
  const spawnChild = (scenario: string): Subprocess<'ignore', 'ignore', 'pipe'> => {
    const child = spawnWithHangGuard(['bun', CHILD, scenario, backend, storagePath, markerPath], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    children.push(child);
    return child;
  };

  try {
    const crashed = spawnChild('park-after-step-0');
    await crashed.exited;
    expect(crashed.signalCode ?? (await new Response(crashed.stderr).text())).toBe('SIGKILL');
    const { runId } = readChildJson<CrashMarker>(markerPath);

    const relaunched = spawnChild('relaunch-recover');
    // A relaunch that never recovers is killed here and reported as stuck,
    // rather than its duration being measured.
    let killedAtDeadline = false;
    const deadline = runtime.timers.setTimeout(() => {
      killedAtDeadline = true;
      relaunched.kill('SIGKILL');
    }, RELAUNCH_DEADLINE_MS);
    const [, stderr] = await Promise.all([
      relaunched.exited,
      new Response(relaunched.stderr).text(),
    ]);
    runtime.timers.clearTimeout(deadline);
    // The marker below proves a run held for composition (COR-1509) still recovers cleanly.
    expect({
      exitCode: relaunched.exitCode,
      killedAtDeadline,
      unexpectedStderr: unexpectedChildStderr(stderr),
    }).toEqual({ exitCode: 0, killedAtDeadline: false, unexpectedStderr: '' });

    const marker = readChildJson<RelaunchMarker>(join(directory, 'relaunched.json'));
    expect(marker).toEqual({
      runId,
      recoveryOutcome: 'clean',
      durableStatus: 'completed',
      runStatus: 'completed',
      // Step 0 committed before the kill; only the interrupted step ran again.
      stepZeroCalls: 0,
      laterStepCalls: 1,
    });
  } finally {
    stopChildren();
    await Promise.all(children.map((child) => child.exited));
    rmSync(directory, { recursive: true, force: true });
  }
}

// The relaunch case's per-test timeout before it was hoisted: the crash phase plus the relaunch's
// own deadline, so the deadline above, not this guard, reports a stuck relaunch.
const RELAUNCH_HANG_GUARD_MILLISECONDS = 2 * RELAUNCH_DEADLINE_MS;
const relaunchOutcomes = {
  sqlite: await settleScenario(
    (scope) => relaunchScenario('sqlite', scope),
    RELAUNCH_HANG_GUARD_MILLISECONDS,
  ),
  lmdb: await settleScenario(
    (scope) => relaunchScenario('lmdb', scope),
    RELAUNCH_HANG_GUARD_MILLISECONDS,
  ),
};

describe.each(['sqlite', 'lmdb'] as const)('process crash relaunch over %s', (backend) => {
  it('relaunches a Bureau killed with SIGKILL mid-run and recovers the durable run to its terminal result', () => {
    expectScenarioPassed(relaunchOutcomes[backend]);
  });
});
