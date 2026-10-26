/**
 * COR-1390 — a durable run survives the real death of the process that owned
 * it, recovers in exactly one of two racing successors, and keeps its event
 * streams continuous.
 *
 * A child process runs a durable Bureau under `workflow-lease` ownership,
 * commits step 0, records what it observed, and SIGKILLs itself. This test
 * then boots two fresh Bureaus (B and C) over the same storage at once.
 *
 * The one real-time wait is the claim-lapse wait: Weft's claim clock is not
 * injectable through `createRunEngine`, so it is derived from the claim TTL
 * exactly as `create-run-engine-crash-and-adopt.test.ts` does. Every other
 * wait is `child.exited`, the marker file, or a bounded condition poll. The
 * poll carries a tiny real delay because LMDB's completion callbacks starve
 * under a zero-delay macrotask loop (see
 * `event-history-run-ownership-recovery-lmdb.test.ts`).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { stopWhen, createAgent } from '@lostgradient/operative';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { createTool, createToolbox } from 'armorer';
import type { Subprocess } from 'bun';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureau } from './create-bureau';
import {
  expectScenarioPassed,
  type ScenarioScope,
  settleScenario,
  waitForBureauState,
} from './test/hoisted-scenario';
import type { Bureau } from './types';
import { unexpectedChildStderr } from './test/child-stderr';
import type { AgentDefinitions } from './agent-catalog';

const CHILD = join(import.meta.dir, 'test', 'process-crash-child.ts');

/** Must match the constants in `test/process-crash-child.ts`. */
const CLAIM_TTL_MS = 200;
const CLAIM_RENEW_MS = 50;
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

function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

interface Racer {
  readonly bureau: Bureau;
  readonly stepsAtOrAfterOne: () => number;
  readonly stepZeroCalls: () => number;
}

async function startRacer(backend: Backend, storagePath: string): Promise<Racer> {
  let stepsAtOrAfterOne = 0;
  let stepZeroCalls = 0;
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: async ({ step }) => {
          if (step === 0) stepZeroCalls += 1;
          else stepsAtOrAfterOne += 1;
          return { content: `recovered step ${step}`, toolCalls: [] };
        },
        toolbox: createToolbox([createNextTool()]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: { type: backend, path: storagePath },
    durable: true,
    durableOwnership: {
      ownership: 'workflow-lease',
      workflowClaimTtlMs: CLAIM_TTL_MS,
      workflowClaimRenewIntervalMs: CLAIM_RENEW_MS,
    },
  });
  return {
    bureau,
    stepsAtOrAfterOne: () => stepsAtOrAfterOne,
    stepZeroCalls: () => stepZeroCalls,
  };
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
  const racers: Racer[] = [];
  // A hung scenario never reaches its `finally`, so what it owns is released from here.
  scope.onHang(async () => {
    await Promise.allSettled(racers.map((racer) => racer.bureau.shutdown()));
    rmSync(directory, { recursive: true, force: true });
  });

  try {
    // Premise: the child died from SIGKILL and left its marker.
    const child = spawnWithHangGuard(
      ['bun', CHILD, 'park-after-step-0', backend, storagePath, markerPath],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    scope.onHang(() => child.kill());
    await child.exited;
    const crashedAt = runtime.clock.now();
    const stderr = await new Response(child.stderr).text();
    expect(child.signalCode ?? stderr).toBe('SIGKILL');
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as CrashMarker;
    expect(typeof marker.maxAuditSequence).toBe('number');
    expect(typeof marker.sessionLastSequence).toBe('number');

    // The dead holder's claim lapses on Weft's own wall clock.
    await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10));

    const started = await Promise.allSettled([
      startRacer(backend, storagePath),
      startRacer(backend, storagePath),
    ]);
    for (const outcome of started) {
      if (outcome.status === 'fulfilled') racers.push(outcome.value);
    }
    for (const outcome of started) {
      if (outcome.status === 'rejected') throw outcome.reason;
    }
    const [b, c] = racers as [Racer, Racer];

    for (const racer of racers) {
      const report = await racer.bureau.waitForRecovery?.();
      if (report === undefined) throw new Error('waitForRecovery is unavailable');
      expect(report.outcome).toBe('clean');
      expect(report.perRunFailures).toEqual([]);
    }

    // Recovery: exactly one racer completes the run locally.
    const bureaus = racers.map((racer) => racer.bureau);
    await waitForBureauState(
      bureaus,
      () => racers.some((racer) => racer.bureau.getRun(marker.runId)?.status === 'completed'),
      { runIds: [marker.runId] },
    );
    const winners = racers.filter(
      (racer) => racer.bureau.getRun(marker.runId)?.status === 'completed',
    );
    expect(winners).toHaveLength(1);
    const winner = winners[0] as Racer;

    for (const racer of racers) {
      // Weft's own result waiter: it settles after the durable commit, for the loser too.
      await racer.bureau.waitForDurableRun(marker.runId);
      const durableRun = await racer.bureau.getDurableRun(marker.runId);
      expect(durableRun?.status).toBe('completed');
    }

    const asOwner = await winner.bureau.eventHistory(
      { kind: 'run', id: marker.runId },
      { principal: 'alice' },
    );
    if ('outcome' in asOwner) {
      throw new Error(`expected a page for alice, got ${JSON.stringify(asOwner)}`);
    }
    const kinds = asOwner.events.map((event) => event.kind);
    expect(kinds.filter((kind) => kind === 'run.completed')).toHaveLength(1);
    expect(kinds).not.toContain('run.error');
    expect(kinds).not.toContain('run.aborted');
    expect(
      await winner.bureau.eventHistory({ kind: 'run', id: marker.runId }, { principal: 'mallory' }),
    ).toEqual({ outcome: 'not-found' });

    // Fencing: the post-crash step ran once across both racers; step 0 never reran.
    expect(b.stepsAtOrAfterOne() + c.stepsAtOrAfterOne()).toBe(1);
    expect(b.stepZeroCalls() + c.stepZeroCalls()).toBe(0);

    const auditTrail = winner.bureau.auditTrail;
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
    const resumed = await winner.bureau.eventHistory(
      { kind: 'session', id: marker.sessionId },
      { since: marker.sessionCursor },
    );
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
    // allSettled never rejects, so the directory is always removed after both shutdowns.
    const reports = await Promise.allSettled(racers.map((racer) => racer.bureau.shutdown()));
    rmSync(directory, { recursive: true, force: true });
    for (const report of reports) {
      expect(report.status).toBe('fulfilled');
      if (report.status === 'fulfilled') expect(report.value.unresolved).toBe(0);
    }
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
    const { runId } = JSON.parse(readFileSync(markerPath, 'utf8')) as CrashMarker;

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

    const marker = JSON.parse(
      readFileSync(join(directory, 'relaunched.json'), 'utf8'),
    ) as RelaunchMarker;
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
