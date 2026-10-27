import {
  MemoryStorage,
  Scheduler,
  workflow,
  yieldToPortableEventLoop,
  type WorkflowLogRecord,
  type WorkflowStatus,
} from '@lostgradient/weft';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { waitUntil } from '@lostgradient/testing/wait-until';
import { createRunEngine, type RegistryAgnosticEngine } from './create-run-engine';

/**
 * AB-348: split out of `create-run-engine.test.ts` (originally AB-330).
 * These two tests prove that Weft's durable-timer poller stays UNARMED
 * (`Scheduler.prototype.start` never called) when `createRunEngine` is
 * configured with `recover: false` or `startScheduler: false`. The original
 * form paired the `schedulerStartSpy` assertion with a real-time wait
 * ("give a real-time poller adequate opportunity to fire") to observe the
 * run staying non-terminal — reasoning that a manual clock cannot prove an
 * absence over real wall-clock time.
 *
 * That real-time wait was never load-bearing: `Scheduler.prototype.start`
 * is the ONE production call site (confirmed by reading `create-run-engine.ts`
 * and Weft's `Engine.create`) through which anything could ever begin
 * polling and firing due timers on a real interval — nothing else in
 * `createRunEngine`'s or Weft's public surface can drive a real-time poller
 * into existence. `expect(schedulerStartSpy).not.toHaveBeenCalled()` is
 * therefore already a complete, deterministic proof that no real-time poller
 * was ever armed; waiting afterward to see whether one fires anyway adds no
 * coverage; it only pads runtime. This split-out issue confirmed there is no
 * `getNow`/clock passthrough on `createRunEngine`'s options or on Weft's
 * `Engine.create` (the source options in `packages/weft/src/core/types/options.ts`
 * have no `clock`/`now`/`getNow` field), so this is the "replace with an
 * equivalent deterministic assertion" path, not a production seam addition.
 */

const TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

// Drain Weft's deferred inline-launch queue between tests — a pending setTimeout(0)
// inline-launch left by one durable run can starve a later one under full
// `bun test` concurrency (CI).
afterEach(async () => {
  await yieldToPortableEventLoop();
});

// Sleep duration parked workflows use — arbitrary, since nothing here waits
// out real time against it; `assertRunStaysParkedWhenPollerUnarmed` drives
// the scheduler directly, past any deadline, with `FAR_FUTURE_EPOCH_MILLISECONDS`.
const PARKED_SLEEP_MILLISECONDS = 50;
// Fixed, arbitrarily far-future epoch millisecond value used to tick the
// scheduler unambiguously past a parked timer's deadline. Not derived from
// the real clock: the deadline itself is computed from Weft's real getNow()
// when ctx.sleep() ran (bounded by whenever the test executes, far short of
// this constant), so any sufficiently distant future instant works.
const FAR_FUTURE_EPOCH_MILLISECONDS = 4_102_444_800_000; // 2100-01-01T00:00:00.000Z
// COR-1610: the engine that parks a run reads this frozen clock instead of the host's. Weft fixes a
// sleep's deadline when the run starts and completes an already-due sleep at once, writing no timer,
// so on a loaded host a 50 ms sleep could expire before it parked. A frozen clock keeps the run parked
// until a test fires it; the scheduler spies, not the clock, are what prove a poller unarmed.
const FROZEN_ENGINE_NOW_MILLISECONDS = 1_000_000;

// Logged by makeSleepingWorkflow on the step BEFORE ctx.sleep. Observing it via
// the onLog sink is positive proof the generator actually reached the sleep —
// "non-terminal" alone would also hold if the run never started, which is not
// what the parked-timer tests mean to assert.
const REACHED_SLEEP_MARKER = 'reached sleep';

/**
 * A probe workflow that parks on a durable `ctx.sleep` before finishing. It logs
 * {@link REACHED_SLEEP_MARKER} on the step immediately before the sleep, so a test
 * can prove the generator reached the timer.
 */
function makeSleepingWorkflow(sleepMilliseconds: number) {
  return workflow({ name: 'agentRun' }).execute(async function* (ctx, input: { value: number }) {
    ctx.log?.info(REACHED_SLEEP_MARKER);
    yield* ctx.sleep(sleepMilliseconds);
    return { doubled: input.value * 2 };
  });
}
async function pollUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  await waitUntil(predicate, { message: 'pollUntil' });
}

/**
 * Assert a run parks on its durable `ctx.sleep` because nothing drives the
 * scheduler, then fires the moment the scheduler is driven explicitly. See
 * `create-run-engine.test.ts`'s original JSDoc (AB-296) for the full
 * three-step rationale this mirrors.
 */
async function assertRunStaysParkedWhenPollerUnarmed(
  engine: RegistryAgnosticEngine,
  reachedSleepMarkers: readonly WorkflowLogRecord[],
) {
  const handle = await engine.start('agentRun', { value: 21 });
  await pollUntil(async () => {
    if (reachedSleepMarkers.length < 1) return false;
    const snapshot = await handle.snapshot();
    return snapshot !== null && !TERMINAL_STATUSES.has(snapshot.status);
  });
  expect(reachedSleepMarkers.length).toBe(1);
  const parkedSnapshot = await handle.snapshot();
  expect(parkedSnapshot).not.toBeNull();
  expect(TERMINAL_STATUSES.has(parkedSnapshot!.status)).toBe(false);
  // Drive the scheduler directly past the timer's deadline.
  await engine.scheduler.tick(FAR_FUTURE_EPOCH_MILLISECONDS);
  await pollUntil(async () => {
    const snapshot = await handle.snapshot();
    return snapshot !== null && TERMINAL_STATUSES.has(snapshot.status);
  });
  const firedSnapshot = await handle.snapshot();
  expect(firedSnapshot).not.toBeNull();
  expect(firedSnapshot!.status).toBe('completed');
}

describe('createRunEngine — poller-unarmed proof (#590)', () => {
  it('leaves durable ctx.sleep timers parked under recover:false without startScheduler (#590)', async () => {
    const schedulerStartSpy = spyOn(Scheduler.prototype, 'start');
    const reachedSleep: WorkflowLogRecord[] = [];
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeSleepingWorkflow(PARKED_SLEEP_MILLISECONDS),
      getNow: () => FROZEN_ENGINE_NOW_MILLISECONDS,
      recover: false,
      onLog: (record) => {
        if (record.message === REACHED_SLEEP_MARKER) reachedSleep.push(record);
      },
    });

    try {
      // Direct proof: recover:false with no startScheduler must never call
      // Scheduler.start(), so the real-time polling interval is never set up.
      expect(schedulerStartSpy).not.toHaveBeenCalled();
      await assertRunStaysParkedWhenPollerUnarmed(engine, reachedSleep);
    } finally {
      schedulerStartSpy.mockRestore();
      engine[Symbol.dispose]();
    }
  });

  it('does not arm the scheduler when startScheduler:false overrides recover:true (#590)', async () => {
    const schedulerStartSpy = spyOn(Scheduler.prototype, 'start');
    const reachedSleep: WorkflowLogRecord[] = [];
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: makeSleepingWorkflow(PARKED_SLEEP_MILLISECONDS),
      getNow: () => FROZEN_ENGINE_NOW_MILLISECONDS,
      recover: true,
      startScheduler: false,
      onLog: (record) => {
        if (record.message === REACHED_SLEEP_MARKER) reachedSleep.push(record);
      },
    });

    try {
      // Direct proof: startScheduler:false must suppress the call even when
      // recover:true — Scheduler.start() must never be invoked.
      expect(schedulerStartSpy).not.toHaveBeenCalled();
      await assertRunStaysParkedWhenPollerUnarmed(engine, reachedSleep);
    } finally {
      schedulerStartSpy.mockRestore();
      engine[Symbol.dispose]();
    }
  });
});
