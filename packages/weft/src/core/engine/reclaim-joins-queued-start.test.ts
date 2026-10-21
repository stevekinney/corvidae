/**
 * An inline start's launch is queued, and its generator exists only once the queue flushes. A
 * reclaim can meet the run in that state: a listing takes its exclude set before the start folds
 * its claim and then lists the start's own holder record, so the pass redrives a run this engine
 * is about to drive itself. The reclaim joins the queued launch: it waits for the flush to settle,
 * and then drives the run only if the flush did not (COR-1618).
 *
 * A queued launch that throws before its generator exists drives nothing, and nothing else would:
 * the engine holds the run's checkpoint and renews its claim, which hides the run from
 * `recoverAll()` and from the reclaim scan alike. So the flush reports the failure and lets the
 * run go, in memory and durably, and the next reclaim pass acquires and drives it as an ownerless
 * running workflow.
 *
 * Scheduling is `'manual'` to pin "queued, not yet flushed"; under `'event-loop'` the flush is a
 * macrotask away and the same window is open until it runs.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { CleanupWarningEvent } from '../events.ts';
import { currentExecutionAttempt } from './execution-attempts.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { countingWorkflow, letOtherDrivesStart, probeFor } from './reclaim-race.test-support.ts';
import type { WorkflowClaimRenewalPassResult } from './workflow-claim-renewal-task.ts';

const WORKFLOW_ID = 'queued-start-run';
const FLUSH_FAILURE = 'transient storage error in the queued launch';

class RacingStorage extends MemoryStorage {
  /** While set, the holder scan of a reclaim listing waits here. */
  holderScanGate: PromiseWithResolvers<void> | null = null;
  readonly reachedHolderScan = Promise.withResolvers<void>();
  /** When armed, the next read of the run's state throws once. */
  failNextStateRead = false;
  stateReadFailures = 0;

  override async *scan(
    prefix: string,
    options?: Parameters<MemoryStorage['scan']>[1],
  ): AsyncIterable<[string, Uint8Array]> {
    if (this.holderScanGate !== null && prefix === KEYS.workflowOwnerHolder('')) {
      const gate = this.holderScanGate;
      this.holderScanGate = null;
      this.reachedHolderScan.resolve();
      await gate.promise;
    }
    yield* super.scan(prefix, options);
  }

  override async get(key: string): Promise<Uint8Array | null> {
    if (this.failNextStateRead && key === KEYS.workflow(WORKFLOW_ID)) {
      this.failNextStateRead = false;
      this.stateReadFailures++;
      throw new Error(FLUSH_FAILURE);
    }
    return super.get(key);
  }
}

function createEngine(storage: RacingStorage) {
  return Engine.create({
    storage,
    workflows: { counted: countingWorkflow(storage) },
    ownership: 'workflow-lease',
    backgroundTasks: 'manual',
    startScheduler: false,
    recover: false,
    inlineLaunchScheduling: 'manual',
  });
}

type CountingEngine = Awaited<ReturnType<typeof createEngine>>;

function collectWarnings(engine: CountingEngine): CleanupWarningEvent[] {
  const warnings: CleanupWarningEvent[] = [];
  engine.addEventListener(CleanupWarningEvent.type, (event) => {
    warnings.push(event);
  });
  return warnings;
}

/**
 * Starts the run while a reclaim pass is inside its holder scan, so the pass lists the start's
 * own claim and reaches the run's redrive while the launch is still queued. The pass is returned
 * unsettled, inside an object so that awaiting this function does not await the pass: it settles
 * only once the test flushes the launch.
 */
async function listQueuedStartInReclaimPass(
  engine: CountingEngine,
  storage: RacingStorage,
): Promise<{ pass: Promise<WorkflowClaimRenewalPassResult> }> {
  const internals = getInternals(engine);
  const holderScanGate = Promise.withResolvers<void>();
  storage.holderScanGate = holderScanGate;
  const pass = internals.workflowClaimRenewalTask!.runOnce();
  await storage.reachedHolderScan.promise;

  await engine.start('counted', null, { id: WORKFLOW_ID });
  expect(internals.workflowClaimRegistry!.currentEpoch(WORKFLOW_ID)).not.toBeNull();
  expect(internals.queuedInlineWorkflowStartIds.has(WORKFLOW_ID)).toBe(true);

  holderScanGate.resolve();
  await letOtherDrivesStart();
  // The launch is still queued: nothing has driven the run, and the pass has not either.
  expect(probeFor(storage).runs).toBe(0);
  expect(internals.inlineStrategy!.hasGenerator(WORKFLOW_ID)).toBe(false);
  return { pass };
}

describe('a reclaim that meets a start whose inline launch is still queued', () => {
  it('drives the run itself once the queued launch has failed', async () => {
    const storage = new RacingStorage();
    await using engine = await createEngine(storage);
    const warnings = collectWarnings(engine);
    const probe = probeFor(storage);
    const { pass } = await listQueuedStartInReclaimPass(engine, storage);

    storage.failNextStateRead = true;
    await engine.flushInlineLaunches();
    expect(storage.stateReadFailures).toBe(1);

    const result = await pass;
    expect(result.reclaim).toMatchObject({
      status: 'completed',
      outcomes: [{ workflowId: WORKFLOW_ID, status: 'reclaimed' }],
    });
    await waitForCondition(() => probe.runs === 1, { label: 'the reclaim drives the run' });
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
    expect(warnings.map((warning) => warning.error.message)).toEqual([FLUSH_FAILURE]);
  });

  it('leaves the run to the queued launch when it succeeds', async () => {
    const storage = new RacingStorage();
    await using engine = await createEngine(storage);
    const warnings = collectWarnings(engine);
    const probe = probeFor(storage);
    const { pass } = await listQueuedStartInReclaimPass(engine, storage);

    await engine.flushInlineLaunches();

    const result = await pass;
    expect(result.reclaim).toMatchObject({
      status: 'completed',
      outcomes: [{ workflowId: WORKFLOW_ID, status: 'reclaimed' }],
    });
    await waitForCondition(() => probe.runs === 1, { label: 'the queued launch drives the run' });
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
    expect(warnings).toEqual([]);
  });
});

describe('a queued inline launch that fails before its generator exists', () => {
  it('reports the failure and lets the run go, and the next reclaim pass drives it', async () => {
    const storage = new RacingStorage();
    await using engine = await createEngine(storage);
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;
    const warnings = collectWarnings(engine);
    const probe = probeFor(storage);
    await engine.start('counted', null, { id: WORKFLOW_ID });
    expect(registry.currentEpoch(WORKFLOW_ID)).not.toBeNull();

    storage.failNextStateRead = true;
    await engine.flushInlineLaunches();
    expect(storage.stateReadFailures).toBe(1);
    expect(probe.runs).toBe(0);
    expect(
      warnings.map((warning) => [warning.source, warning.workflowId, warning.error.message]),
    ).toEqual([['inline-launch', WORKFLOW_ID, FLUSH_FAILURE]]);

    // In memory the engine no longer holds the run; durably it is running and ownerless, which is
    // what the reclaim scan looks for.
    expect(internals.checkpoints.has(WORKFLOW_ID)).toBe(false);
    expect(currentExecutionAttempt(internals, WORKFLOW_ID)).toBeUndefined();
    expect(internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID)).toBe(false);
    expect(registry.currentEpoch(WORKFLOW_ID)).toBeNull();
    expect(await storage.get(KEYS.workflowOwnerHolder(WORKFLOW_ID))).toBeNull();

    const pass = await internals.workflowClaimRenewalTask!.runOnce();
    expect(pass.reclaim).toMatchObject({
      status: 'completed',
      outcomes: [{ workflowId: WORKFLOW_ID, status: 'reclaimed' }],
    });
    await waitForCondition(() => probe.runs === 1, { label: 'the reclaim drives the run' });
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
  });
});
