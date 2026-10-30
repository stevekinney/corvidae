/**
 * COR-1391 — in-flight work stays intact across a SIGKILLed Bureau.
 *
 * Durable runs are at-least-once at step granularity: a crash after a step's
 * tools or `onStep` hooks ran, but before its memo committed, replays the whole
 * step. Three SIGKILL scenarios (see `test/process-crash-child.ts`) prove, over
 * SQLite and LMDB, that:
 *
 * 1. a replayed step repeats neither an idempotent tool's external effect nor
 *    a governed-memory write;
 * 2. aborting one recovered run terminates only that run;
 * 3. after recovery and `shutdown()`, a fresh process opens the same store and
 *    finds no running workflow and no unresolved idempotency attempt.
 *
 * The one real-time wait is the claim-lapse wait, derived from the claim TTL as
 * in `process-crash-recovery.test.ts`. Every other wait is `child.exited`, a
 * marker file, or a bounded condition poll with a tiny real delay (LMDB's
 * completion callbacks starve under a zero-delay macrotask loop).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import type { GenerateFunction } from '@lostgradient/operative';
import type { Storage } from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  type Backend,
  CHARGE_ORDER_ID,
  chargeStatus,
  chargeToolCalls,
  CLAIM_TTL_MS,
  createChargeToolbox,
  createHarnessBureau,
  firstUserMessage,
  inspector,
  inspectorFor,
  openGovernedMemory,
  openIdempotencyCache,
  readEffects,
  REMEMBERED_ANSWER,
} from './test/process-crash-work-integrity-fixtures';
import {
  expectScenarioPassed,
  type ScenarioScope,
  settleScenario,
  waitForBureauState,
} from './test/hoisted-scenario';
import type { Bureau } from './types';
import { unexpectedChildStderr } from './test/child-stderr';
import { createLmdbStorageFixture, createSqliteStorageFixture } from './test/storage-fixtures';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { readChildJson } from './test/child-output-file';

const CHILD = join(import.meta.dir, 'test', 'process-crash-child.ts');
const runtime = createDefaultRuntimeServices();

interface Scenario {
  readonly backend: Backend;
  readonly directory: string;
  readonly storagePath: string;
  readonly markerPath: string;
  /**
   * Registers a disposer that runs exactly once, whether the body calls the returned function
   * or `finally` does. Disposers run sequentially, last-registered first.
   */
  readonly onCleanup: <T>(closer: () => T) => () => T;
}

async function withScenario(
  backend: Backend,
  scope: ScenarioScope,
  body: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `corvidae-work-integrity-${backend}-`));
  const closers: Array<() => unknown> = [];
  // A hung scenario never reaches the cleanup below, so the same closers run from here.
  scope.onHang(async () => {
    for (const closer of closers.toReversed()) {
      await Promise.resolve()
        .then(closer)
        .catch(() => {});
    }
    rmSync(directory, { recursive: true, force: true });
  });
  let bodyError: { error: unknown } | undefined;
  try {
    await body({
      backend,
      directory,
      storagePath: join(directory, 'bureau'),
      markerPath: join(directory, 'marker.json'),
      onCleanup: <T>(closer: () => T) => {
        let result: { value: T } | undefined;
        const once = () => {
          result ??= { value: closer() };
          return result.value;
        };
        closers.push(once);
        return once;
      },
    });
  } catch (error) {
    bodyError = { error };
  }
  const failures: unknown[] = [];
  for (const closer of closers.toReversed()) {
    try {
      await closer();
    } catch (error) {
      failures.push(error);
    }
  }
  rmSync(directory, { recursive: true, force: true });
  // A cleanup failure must not mask the body's own error.
  if (bodyError !== undefined) throw bodyError.error;
  if (failures.length > 0) throw new AggregateError(failures, 'scenario cleanup failed');
}

async function spawnChild(
  scenario: Scenario,
  name: string,
  variant?: string,
): Promise<{
  readonly signalCode: string | number | null;
  readonly exitCode: number | null;
  stderr: string;
}> {
  const child = spawnWithHangGuard(
    [
      'bun',
      CHILD,
      name,
      scenario.backend,
      scenario.storagePath,
      scenario.markerPath,
      ...(variant === undefined ? [] : [variant]),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  scenario.onCleanup(() => child.kill());
  await child.exited;
  const stderr = await new Response(child.stderr).text();
  return { signalCode: child.signalCode, exitCode: child.exitCode, stderr };
}

/**
 * The scenario's store, opened once the child is gone, and closed by the scenario's cleanup after
 * the Bureau that a later `onCleanup` registers has shut down.
 */
function scenarioStorage(backend: Backend, scenario: Scenario): Storage {
  const store =
    backend === 'lmdb'
      ? createLmdbStorageFixture({ path: scenario.storagePath })
      : createSqliteStorageFixture({ path: scenario.storagePath });
  scenario.onCleanup(() => store.dispose());
  return store.storage;
}

function readMarker<T>(scenario: Scenario): T {
  expect(existsSync(scenario.markerPath)).toBe(true);
  return readChildJson<T>(scenario.markerPath);
}

/** Spawns a crashing scenario and asserts the premise: SIGKILL plus a marker. */
async function crash<T>(scenario: Scenario, name: string, variant?: string): Promise<T> {
  const outcome = await spawnChild(scenario, name, variant);
  expect(outcome.signalCode ?? outcome.stderr).toBe('SIGKILL');
  const marker = readMarker<T>(scenario);
  // The dead holder's claim lapses on Weft's own wall clock.
  await new Promise<void>((resolve) => runtime.timers.setTimeout(resolve, CLAIM_TTL_MS * 10));
  return marker;
}

async function expectVerifyClean(scenario: Scenario): Promise<void> {
  const outcome = await spawnChild(scenario, 'verify');
  expect(unexpectedChildStderr(outcome.stderr)).toBe('');
  expect(outcome.signalCode).toBeNull();
  expect(outcome.exitCode).toBe(0);
  const marker = readMarker<{ recoveryOutcome: string; running: number }>(scenario);
  expect(marker.running).toBe(0);
  expect(marker.recoveryOutcome).toBe('clean');
}

async function expectShutdownReleased(
  shutdown: () => ReturnType<Bureau['shutdown']>,
): Promise<void> {
  const report = await shutdown();
  expect(report.unresolved).toBe(0);
  expect(report.failed).toBe(0);
}

function createNextTool() {
  return createTool({
    name: 'next',
    description: 'continue',
    input: z.object({}),
    execute: async () => 'ok',
  });
}

function requireAuditTrail(bureau: Bureau) {
  if (bureau.internals.auditTrail === undefined) throw new Error('the bureau has no audit trail');
  return bureau.internals.auditTrail;
}

async function recoveredRunCompleted(bureau: Bureau, runId: string): Promise<boolean> {
  await waitForBureauState([bureau], () => bureau.tasks.detail(runId)?.status === 'completed', {
    runIds: [runId],
  });
  await bureau.recovery();
  return true;
}

async function recoverCharge(backend: Backend, scenario: Scenario, wrap: boolean) {
  const marker = await crash<{ runId: string }>(
    scenario,
    'charge-then-crash',
    wrap ? undefined : 'unwrapped',
  );
  const idempotency = await openIdempotencyCache(scenario.directory);
  const closeIdempotency = scenario.onCleanup(() => idempotency.close());
  const stepZeroCalls: number[] = [];
  const generate: GenerateFunction = async ({ step }) => {
    if (step > 0) return { content: 'charged', toolCalls: [] };
    stepZeroCalls.push(step);
    return { content: 'charging', toolCalls: chargeToolCalls };
  };
  const bureau = await createHarnessBureau({
    storage: scenarioStorage(backend, scenario),
    generate,
    toolbox: createChargeToolbox(scenario.directory, async () => 'ok', {
      cache: idempotency.cache,
      wrap,
    }),
  });
  const shutdown = scenario.onCleanup(() => bureau.shutdown());
  return { marker, bureau, shutdown, closeIdempotency, stepZeroCalls };
}

async function idempotentChargeScenario(backend: Backend, scope: ScenarioScope): Promise<void> {
  await withScenario(backend, scope, async (scenario) => {
    const { marker, bureau, shutdown, closeIdempotency, stepZeroCalls } = await recoverCharge(
      backend,
      scenario,
      true,
    );
    expect(await recoveredRunCompleted(bureau, marker.runId)).toBe(true);
    // Premise: step 0 never committed, so it replayed.
    expect(stepZeroCalls).toHaveLength(1);

    expect(readEffects(scenario.directory)).toEqual([`charged ${CHARGE_ORDER_ID}`]);
    const settled = await requireAuditTrail(bureau).query({
      runId: marker.runId,
      type: 'tool.settled',
    });
    const charges = settled.filter(
      (record) => (record.detail as { toolName?: string } | undefined)?.toolName === 'charge',
    );
    expect(charges.length).toBeGreaterThan(0);
    // Every settled record, including the replayed (deduplicated) one, carries the result.
    for (const record of charges) {
      expect((record.detail as { result?: unknown }).result).toBe(`charged:${CHARGE_ORDER_ID}`);
    }

    await expectShutdownReleased(shutdown);
    await closeIdempotency();
    await expectVerifyClean(scenario);

    // A fresh cache over the same sidecar file sees a completed entry, not an orphaned marker.
    const fresh = await openIdempotencyCache(scenario.directory);
    scenario.onCleanup(() => fresh.close());
    expect(await chargeStatus(fresh.store, fresh.cache)).toBe('completed');
  });
}

async function controlChargeScenario(backend: Backend, scope: ScenarioScope): Promise<void> {
  await withScenario(backend, scope, async (scenario) => {
    const { marker, bureau, shutdown, stepZeroCalls } = await recoverCharge(
      backend,
      scenario,
      false,
    );
    expect(await recoveredRunCompleted(bureau, marker.runId)).toBe(true);
    expect(stepZeroCalls).toHaveLength(1);
    expect(readEffects(scenario.directory)).toEqual([
      `charged ${CHARGE_ORDER_ID}`,
      `charged ${CHARGE_ORDER_ID}`,
    ]);
    await expectShutdownReleased(shutdown);
  });
}

async function governedMemoryScenario(backend: Backend, scope: ScenarioScope): Promise<void> {
  await withScenario(backend, scope, async (scenario) => {
    const marker = await crash<{ runId: string; sessionId: string }>(
      scenario,
      'memory-write-then-crash',
    );
    const governed = await openGovernedMemory(scenario.directory);
    const closeGoverned = scenario.onCleanup(() => governed.close());
    const stepZeroCalls: number[] = [];
    const bureau = await createHarnessBureau({
      storage: scenarioStorage(backend, scenario),
      generate: async ({ step }) => {
        if (step === 0) stepZeroCalls.push(step);
        return { content: REMEMBERED_ANSWER, toolCalls: [] };
      },
      toolbox: createToolbox([createNextTool()]),
      memory: governed.memory,
    });
    const shutdown = scenario.onCleanup(() => bureau.shutdown());

    expect(await recoveredRunCompleted(bureau, marker.runId)).toBe(true);
    expect(stepZeroCalls).toHaveLength(1);

    const records = await governed.memory.list(inspector, { collection: 'default' });
    expect(records).toHaveLength(1);
    expect(records[0]?.metadata['dedupeKey']).toBe(`${marker.runId}:0`);
    // The recovered run kept writing as its owner of record (COR-1546): had it written as another
    // owner, the replayed step would not have found its own record and stored a second one there.
    expect(
      await governed.memory.list(inspectorFor('anonymous:local'), { collection: 'default' }),
    ).toEqual([]);

    await expectShutdownReleased(shutdown);
    closeGoverned();
    await expectVerifyClean(scenario);
  });
}

async function abortSiblingScenario(backend: Backend, scope: ScenarioScope): Promise<void> {
  await withScenario(backend, scope, async (scenario) => {
    const marker = await crash<{ xRunId: string; yRunId: string }>(scenario, 'two-parked-runs');
    const generateObservers = new Set<() => void>();
    const deferreds = new Map<string, PromiseWithResolvers<{ content: string; toolCalls: [] }>>();
    const calls: Array<{ message: string; step: number }> = [];
    const generate: GenerateFunction = async (context) => {
      const message = firstUserMessage(context);
      calls.push({ message, step: context.step });
      for (const observer of generateObservers) observer();
      if (context.step === 0) return { content: 'step 0', toolCalls: [] };
      const deferred = Promise.withResolvers<{ content: string; toolCalls: [] }>();
      deferreds.set(message, deferred);
      context.signal?.addEventListener('abort', () => deferred.reject(context.signal?.reason), {
        once: true,
      });
      return deferred.promise;
    };
    const bureau = await createHarnessBureau({
      storage: scenarioStorage(backend, scenario),
      generate,
      toolbox: createToolbox([createNextTool()]),
    });
    const shutdown = scenario.onCleanup(() => bureau.shutdown());
    await bureau.recovery();

    await waitForBureauState(
      [bureau],
      () =>
        bureau.tasks.detail(marker.xRunId)?.status === 'running' &&
        bureau.tasks.detail(marker.yRunId)?.status === 'running' &&
        deferreds.has('crash harness run X') &&
        deferreds.has('crash harness run Y'),
      {
        runIds: [marker.xRunId, marker.yRunId],
        // A pending `generate` emits no frame while it is held, so its call is the announcement.
        onChange: (notify) => {
          generateObservers.add(notify);
          return () => generateObservers.delete(notify);
        },
      },
    );
    expect(calls.every((call) => call.step >= 1)).toBe(true);
    const callsBeforeAbort = calls.length;
    const xMessage = 'crash harness run X';
    const xCallsBeforeAbort = calls.filter((call) => call.message === xMessage).length;

    expect(await bureau.tasks.cancel(marker.xRunId)).toMatchObject({ receipt: 'cancel-requested' });
    await waitForBureauState(
      [bureau],
      () => bureau.tasks.detail(marker.xRunId)?.status === 'aborted',
      {
        runIds: [marker.xRunId],
      },
    );
    const durableX = await bureau.tasks.workflow(marker.xRunId);
    expect(durableX?.status).not.toBe('running');
    expect(durableX?.status).not.toBe('completed');
    await waitForBureauState([bureau], () => bureau.internals.abortingTasks().length === 0, {
      runIds: [marker.xRunId],
    });

    const xEvents = await bureau.tasks.events(marker.xRunId);
    if ('outcome' in xEvents) throw new Error(`expected a page, got ${JSON.stringify(xEvents)}`);
    const xKinds = xEvents.events.map((event) => event.kind);
    expect(xKinds.filter((kind) => kind === 'run.aborted')).toHaveLength(1);
    expect(xKinds).not.toContain('run.completed');

    // Y is untouched, and nothing re-entered generate for X.
    expect(bureau.tasks.detail(marker.yRunId)?.status).toBe('running');
    expect(calls).toHaveLength(callsBeforeAbort);

    deferreds.get('crash harness run Y')?.resolve({ content: 'Y done', toolCalls: [] });
    await waitForBureauState(
      [bureau],
      () => bureau.tasks.detail(marker.yRunId)?.status === 'completed',
      {
        runIds: [marker.yRunId],
      },
    );
    const yEvents = await bureau.tasks.events(marker.yRunId);
    if ('outcome' in yEvents) throw new Error(`expected a page, got ${JSON.stringify(yEvents)}`);
    const yKinds = yEvents.events.map((event) => event.kind);
    expect(yKinds.filter((kind) => kind === 'run.completed')).toHaveLength(1);
    expect(yKinds).not.toContain('run.aborted');

    // X was already aborted: a repeat cancel requests nothing new.
    expect(await bureau.tasks.cancel(marker.xRunId)).not.toMatchObject({
      receipt: 'cancel-requested',
    });
    expect(await rejectionOf(bureau.tasks.cancel('process-crash-unknown-run'))).toMatchObject({
      code: 'NOT_FOUND',
    });

    // Still true after Y finished: nothing re-entered generate for X.
    expect(calls.filter((call) => call.message === xMessage)).toHaveLength(xCallsBeforeAbort);
    await expectShutdownReleased(shutdown);
    await expectVerifyClean(scenario);
  });
}

/**
 * Every scenario boots real processes (the SIGKILLed child and, afterwards, a fresh verifying
 * process over the shut-down store), and the verifying process can only run once recovery has
 * finished. So each scenario runs whole, once, at module scope to stay off the per-test clock (see
 * `test/hoisted-scenario.ts`); a scenario's own assertions run there too, and a failure is captured
 * and rethrown by the test that names it.
 */
// The hang guard is the per-test timeout these tests carried before they were hoisted. It only
// stops a genuine hang; every wait for a state change is by event (`waitForBureauState`).
const HANG_GUARD_MILLISECONDS = 120_000;
async function settleBackend(backend: Backend) {
  return {
    idempotent: await settleScenario(
      (scope) => idempotentChargeScenario(backend, scope),
      HANG_GUARD_MILLISECONDS,
    ),
    control: await settleScenario(
      (scope) => controlChargeScenario(backend, scope),
      HANG_GUARD_MILLISECONDS,
    ),
    governedMemory: await settleScenario(
      (scope) => governedMemoryScenario(backend, scope),
      HANG_GUARD_MILLISECONDS,
    ),
    abortSibling: await settleScenario(
      (scope) => abortSiblingScenario(backend, scope),
      HANG_GUARD_MILLISECONDS,
    ),
  };
}
const outcomes = {
  sqlite: await settleBackend('sqlite'),
  lmdb: await settleBackend('lmdb'),
};

describe.each(['sqlite', 'lmdb'] as const)('process crash work integrity over %s', (backend) => {
  it('does not repeat an idempotent tool effect when a crashed step replays', () => {
    expectScenarioPassed(outcomes[backend].idempotent);
  });

  it('control: without idempotency the same crash repeats the tool effect', () => {
    expectScenarioPassed(outcomes[backend].control);
  });

  it('does not repeat a governed-memory write when a crashed step replays', () => {
    expectScenarioPassed(outcomes[backend].governedMemory);
  });

  it('aborting one recovered run leaves its sibling running', () => {
    expectScenarioPassed(outcomes[backend].abortSibling);
  });
});
