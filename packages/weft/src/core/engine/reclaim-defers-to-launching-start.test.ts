/**
 * A delayed start's fire, and a prepared start's launch, hold the claim they folded or committed
 * under across the awaits between their `running` commit and their launch: a re-provision of the
 * run's services, the terminal-cleanup marker read, the start headers. In that window the run is
 * neither queued nor live, so a reclaim pass whose listing predates the fold redrove it: it found
 * nothing to defer to and nothing live, replayed from storage, and the fire then adopted over that
 * replay and enqueued under the same epoch, so two generators drove one generation (COR-1625).
 *
 * The launch now records a launching marker in the turn its commit lands, which a reclaim defers
 * to exactly as it defers to a queued inline start. `engine.get()` keeps reporting `running`. A
 * launch that stops short of its generator lets the run go, claim included, so the next reclaim
 * pass lists the run ownerless and drives it once.
 *
 * Scheduling is `'manual'`, so a queued launch stays queued until the test flushes it, and the
 * reclaim pass is driven by hand, so the listing can be held across the fire's commit.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { createDeferred, waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { workflow, type EngineOptions, type WorkflowServicesResolution } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { countingWorkflow, letOtherDrivesStart, probeFor } from './reclaim-race.test-support.ts';
import { decodeWorkflowState } from './validation.ts';
import type { WorkflowClaimRenewalPassResult } from './workflow-claim-renewal-task.ts';

const WORKFLOW_ID = 'launching-run';
const START_AT = 1_000_000;
const WORKER_URL = new URL('../../workers/test-browser-worker.ts', import.meta.url);

const RECLAIMED = {
  status: 'completed',
  outcomes: [{ workflowId: WORKFLOW_ID, status: 'reclaimed' }],
};

class RacingStorage extends MemoryStorage {
  /** While set, the holder scan of a reclaim listing waits here. */
  holderScanGate: PromiseWithResolvers<void> | null = null;
  readonly reachedHolderScan = Promise.withResolvers<void>();
  /** While set, the next read of this key waits until `releaseHeldRead` is called. */
  holdReadOf: string | null = null;
  readonly reachedHeldRead = Promise.withResolvers<void>();
  readonly #heldRead = Promise.withResolvers<void>();
  /** When set, the next read of this key throws once. */
  failReadOf: string | null = null;
  readReadFailures = 0;
  /** When set, the next conditional batch that writes the run as `failed` throws once. */
  failNextFailedWrite = false;
  failedWriteFaults = 0;

  releaseHeldRead(): void {
    this.#heldRead.resolve();
  }

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

  /** The hold and the fault apply to a key however it is read: `get`, or `has` (`storageHas`). */
  async #interceptRead(key: string): Promise<void> {
    if (key === this.holdReadOf) {
      this.holdReadOf = null;
      this.reachedHeldRead.resolve();
      await this.#heldRead.promise;
    }
    if (key === this.failReadOf) {
      this.failReadOf = null;
      this.readReadFailures++;
      throw new Error('transient storage error in the launch window');
    }
  }

  override async get(key: string): Promise<Uint8Array | null> {
    await this.#interceptRead(key);
    return super.get(key);
  }

  override async has(key: string): Promise<boolean> {
    await this.#interceptRead(key);
    return super.has(key);
  }

  override async conditionalBatch(
    ...args: Parameters<MemoryStorage['conditionalBatch']>
  ): ReturnType<MemoryStorage['conditionalBatch']> {
    const [, operations] = args;
    const writesFailed = operations.some(
      (operation) =>
        operation.type === 'put' &&
        operation.key === KEYS.workflow(WORKFLOW_ID) &&
        decodeWorkflowState(operation.value).status === 'failed',
    );
    if (this.failNextFailedWrite && writesFailed) {
      this.failNextFailedWrite = false;
      this.failedWriteFaults++;
      throw new Error('transient storage error on the terminal write');
    }
    return super.conditionalBatch(...args);
  }
}

type Clock = { now: number };

function createClock(): Clock {
  return { now: START_AT - 60_000 };
}

/** A resolver the test holds, or answers as it chooses. */
function createResolver(answer: () => WorkflowServicesResolution) {
  const reached = createDeferred();
  const release = createDeferred();
  return {
    reached: reached.promise,
    release: () => release.resolve(),
    option: async (): Promise<WorkflowServicesResolution> => {
      reached.resolve();
      await release.promise;
      return answer();
    },
  };
}

function createInlineEngine(
  storage: RacingStorage,
  clock: Clock,
  options: Pick<EngineOptions, 'resolveWorkflowServices'> = {},
) {
  return Engine.create({
    storage,
    workflows: { counted: countingWorkflow(storage) },
    ownership: 'workflow-lease',
    backgroundTasks: 'manual',
    startScheduler: false,
    recover: false,
    inlineLaunchScheduling: 'manual',
    getNow: () => clock.now,
    ...options,
  });
}

const simpleWorkflow = workflow({ name: 'simple' }).execute(async function* (_ctx, input) {
  return { input, computed: 42 };
});

function createWorkerEngine(storage: RacingStorage, clock: Clock) {
  return Engine.create({
    storage,
    workflows: { simple: simpleWorkflow },
    workflowExecutionMode: 'worker',
    workerExecution: { workerUrl: WORKER_URL, poolSize: 1, workflowTurnTimeoutMs: 30_000 },
    ownership: 'workflow-lease',
    backgroundTasks: 'manual',
    startScheduler: false,
    recover: false,
    getNow: () => clock.now,
  });
}

type AnyEngine =
  Awaited<ReturnType<typeof createInlineEngine>> | Awaited<ReturnType<typeof createWorkerEngine>>;

/** Starts a reclaim pass and holds its listing inside the holder scan. */
async function holdReclaimListing(
  engine: AnyEngine,
  storage: RacingStorage,
): Promise<{ pass: Promise<WorkflowClaimRenewalPassResult>; release: () => void }> {
  const gate = Promise.withResolvers<void>();
  storage.holderScanGate = gate;
  const pass = getInternals(engine).workflowClaimRenewalTask!.runOnce();
  await storage.reachedHolderScan.promise;
  return { pass, release: () => gate.resolve() };
}

function countEvents(engine: AnyEngine): { started: number; resumed: number } {
  const counts = { started: 0, resumed: 0 };
  engine.addEventListener('workflow:started', () => {
    counts.started++;
  });
  engine.addEventListener('workflow:resumed', () => {
    counts.resumed++;
  });
  return counts;
}

/** What the engine shows of the run while a launch is held in its window. */
async function observeWindow(engine: AnyEngine) {
  const internals = getInternals(engine);
  const state = await engine.get(WORKFLOW_ID);
  return {
    launching: internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID),
    queued: internals.queuedInlineWorkflowStartIds.has(WORKFLOW_ID),
    status: state?.status,
  };
}

/** The window of a held launch: the run is launching, not queued, and `engine.get()` says running. */
const LAUNCHING_WINDOW: Awaited<ReturnType<typeof observeWindow>> = {
  launching: true,
  queued: false,
  status: 'running',
};

async function statusOf(storage: RacingStorage): Promise<string | undefined> {
  const bytes = await storage.get(KEYS.workflow(WORKFLOW_ID));
  return bytes === null ? undefined : decodeWorkflowState(bytes).status;
}

describe('a reclaim that lists a delayed start between its fold and its launch', () => {
  it('defers to the fire, which drives the run once (inline)', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    await using engine = await createInlineEngine(storage, clock);
    const internals = getInternals(engine);
    const probe = probeFor(storage);
    // The activity is held, so a run still in flight when a second generator starts shows two runs.
    probe.hold = Promise.withResolvers<void>();
    await engine.start('counted', null, { id: WORKFLOW_ID, startAt: START_AT });
    clock.now = START_AT;

    // The listing's exclude set predates the fire's fold, so the pass lists the fire's own claim.
    const listing = await holdReclaimListing(engine, storage);
    // The fire commits, folds its claim, and is held in the window, at the cleanup marker read.
    storage.holdReadOf = KEYS.terminalCleanupNeeded(WORKFLOW_ID);
    const fire = engine.scheduler.tick(clock.now);
    await storage.reachedHeldRead.promise;
    expect(internals.workflowClaimRegistry!.currentEpoch(WORKFLOW_ID)).not.toBeNull();
    const window = await observeWindow(engine);

    // The pass reaches the run while the fire is held, and leaves it to the fire.
    listing.release();
    const result = await listing.pass;
    await letOtherDrivesStart();
    const runsBeforeTheFireLaunched = probe.runs;

    storage.releaseHeldRead();
    await fire;
    await engine.flushInlineLaunches();
    await waitForCondition(() => probe.runs >= 1, { label: 'the fire drives the run' });
    await letOtherDrivesStart();
    probe.hold.resolve();
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
    expect(runsBeforeTheFireLaunched).toBe(0);
    expect(result.reclaim).toMatchObject(RECLAIMED);
    expect(window).toEqual(LAUNCHING_WINDOW);
  });

  it('defers to the fire, which drives the run once (worker)', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    await using engine = await createWorkerEngine(storage, clock);
    const internals = getInternals(engine);
    const events = countEvents(engine);
    await engine.start('simple', null, { id: WORKFLOW_ID, startAt: START_AT });
    clock.now = START_AT;

    const listing = await holdReclaimListing(engine, storage);
    storage.holdReadOf = KEYS.terminalCleanupNeeded(WORKFLOW_ID);
    const fire = engine.scheduler.tick(clock.now);
    await storage.reachedHeldRead.promise;
    const window = await observeWindow(engine);

    listing.release();
    const result = await listing.pass;

    storage.releaseHeldRead();
    await fire;
    // A worker never enqueues, so the launch settles the marker itself once the worker has the run.
    const launchingAfterTheFire =
      internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID);
    expect(await engine.getHandle(WORKFLOW_ID).result()).toEqual({ input: null, computed: 42 });
    // The fire started the run once; the reclaim replayed nothing.
    expect(events).toEqual({ started: 1, resumed: 0 });
    expect(result.reclaim).toMatchObject(RECLAIMED);
    expect(window).toEqual(LAUNCHING_WINDOW);
    expect(launchingAfterTheFire).toBe(false);
  });
});

describe('a reclaim that lists a prepared start between its commit and its launch', () => {
  it('defers to the launch, which drives the run once', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'available', services: { owner: 'again' } }));
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    const probe = probeFor(storage);
    probe.hold = Promise.withResolvers<void>();

    // The listing's exclude set predates the prepare's claim, so the pass lists it; the launch
    // then commits `running` and is held in its window, at the re-provision.
    const listing = await holdReclaimListing(engine, storage);
    const prepared = await engine.prepare('counted', null, {
      id: WORKFLOW_ID,
      services: { owner: 'prepared' },
    });
    // The services left memory with the process that prepared the run, so the launch re-provides.
    internals.workflowServices.delete(WORKFLOW_ID);
    const launching = prepared.launch();
    await resolver.reached;
    const window = await observeWindow(engine);

    // The pass reaches the run while the launch is held, and leaves it to the launch. It is not
    // awaited while the resolver is held: a replay of its own would wait on that resolver too.
    listing.release();
    await letOtherDrivesStart();
    const runsBeforeTheLaunch = probe.runs;

    resolver.release();
    const handle = await launching;
    const result = await listing.pass;
    await engine.flushInlineLaunches();
    await waitForCondition(() => probe.runs >= 1, { label: 'the launch drives the run' });
    await letOtherDrivesStart();
    probe.hold.resolve();
    expect(await handle.result()).toBe('ran');
    expect(probe.runs).toBe(1);
    expect(runsBeforeTheLaunch).toBe(0);
    expect(result.reclaim).toMatchObject(RECLAIMED);
    expect(window).toEqual(LAUNCHING_WINDOW);
  });
});

describe('a delayed start that stops short of its launch', () => {
  it('lets the run go when the window throws, and the next reclaim pass drives it once', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    await using engine = await createInlineEngine(storage, clock);
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;
    const probe = probeFor(storage);
    await engine.start('counted', null, { id: WORKFLOW_ID, startAt: START_AT });
    clock.now = START_AT;

    storage.failReadOf = KEYS.terminalCleanupNeeded(WORKFLOW_ID);
    // The scheduler reports a timer callback that threw on the console. The injected fault is
    // expected, so it is captured and asserted rather than left in the test output, and the spy
    // stays until the fire has reported and let the run go.
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    let reported: string | undefined;
    try {
      await engine.scheduler.tick(clock.now);
      await waitForCondition(() => consoleError.mock.calls.length === 1, {
        label: 'the scheduler reports the failed fire',
      });
      reported = String(consoleError.mock.calls[0]?.[0]);
      await waitForCondition(() => registry.currentEpoch(WORKFLOW_ID) === null, {
        label: 'the fire lets the run go',
      });
    } finally {
      consoleError.mockRestore();
    }
    expect(reported).toContain('Timer callback failed');
    expect(storage.readReadFailures).toBe(1);
    expect(probe.runs).toBe(0);
    // The marker is settled and the folded claim released: the run is running and ownerless.
    expect(internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID)).toBe(false);
    expect(registry.currentEpoch(WORKFLOW_ID)).toBeNull();
    expect(await storage.get(KEYS.workflowOwnerHolder(WORKFLOW_ID))).toBeNull();
    expect(await statusOf(storage)).toBe('running');

    const pass = await internals.workflowClaimRenewalTask!.runOnce();
    expect(pass.reclaim).toMatchObject(RECLAIMED);
    await waitForCondition(() => probe.runs === 1, { label: 'the next pass drives the run' });
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
  });

  it('fails the run and starts no generator when its services are unavailable', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'unavailable', reason: 'gone' }));
    resolver.release();
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    const probe = probeFor(storage);
    await engine.start('counted', null, {
      id: WORKFLOW_ID,
      startAt: START_AT,
      services: { owner: 'delayed' },
    });
    internals.workflowServices.delete(WORKFLOW_ID);
    clock.now = START_AT;

    await engine.scheduler.tick(clock.now);
    await engine.flushInlineLaunches();
    expect(await statusOf(storage)).toBe('failed');
    expect(internals.inlineStrategy!.hasGenerator(WORKFLOW_ID)).toBe(false);
    expect(probe.runs).toBe(0);
    // The failure released the claim with the run; the marker is settled with it.
    expect(internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID)).toBe(false);
    expect(internals.workflowClaimRegistry!.currentEpoch(WORKFLOW_ID)).toBeNull();
  });

  it('lets the run go when the failure commit faults, and the next reclaim pass fails it', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'unavailable', reason: 'gone' }));
    resolver.release();
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;
    const probe = probeFor(storage);
    await engine.start('counted', null, {
      id: WORKFLOW_ID,
      startAt: START_AT,
      services: { owner: 'delayed' },
    });
    internals.workflowServices.delete(WORKFLOW_ID);
    clock.now = START_AT;

    storage.failNextFailedWrite = true;
    await engine.scheduler.tick(clock.now);
    expect(storage.failedWriteFaults).toBe(1);
    expect(await statusOf(storage)).toBe('running');
    // The marker is settled and the folded claim released, so the run is not hidden from the scan.
    expect(internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID)).toBe(false);
    expect(registry.currentEpoch(WORKFLOW_ID)).toBeNull();

    // The next pass acquires the ownerless run and reaches the replay, which fails it for its
    // services instead of deferring to a marker nothing drives.
    const pass = await internals.workflowClaimRenewalTask!.runOnce();
    expect(pass.reclaim).toMatchObject(RECLAIMED);
    await waitForCondition(async () => (await statusOf(storage)) === 'failed', {
      label: 'the next pass fails the run',
    });
    expect(probe.runs).toBe(0);
    expect(internals.inlineStrategy!.hasGenerator(WORKFLOW_ID)).toBe(false);
  });
});

describe('a delayed start that stops short while a same-id replacement lands', () => {
  it('lets go of only its own marker and claim, and the replacement drives once', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'unavailable', reason: 'gone' }));
    resolver.release();
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;
    const probe = probeFor(storage);
    probe.hold = Promise.withResolvers<void>();
    const events = countEvents(engine);
    await engine.start('counted', null, {
      id: WORKFLOW_ID,
      startAt: START_AT,
      services: { owner: 'delayed' },
    });
    internals.workflowServices.delete(WORKFLOW_ID);
    clock.now = START_AT;

    // The services-unavailable failure commits `failed` and releases the fold's claim, then awaits
    // its cleanup. A same-id `start-new` replacement lands in that window: it folds the next epoch
    // and queues its launch, so it holds the id's claim and marker when the old fire's `finally`
    // runs. Modelled by starting the replacement right after the first release of the id resolves.
    const originalRelease = registry.release.bind(registry);
    let replaced = false;
    registry.release = async (workflowId, expectedEpoch) => {
      const result = await originalRelease(workflowId, expectedEpoch);
      if (!replaced && workflowId === WORKFLOW_ID) {
        replaced = true;
        await engine.start('counted', null, { id: WORKFLOW_ID, onTerminalConflict: 'start-new' });
      }
      return result;
    };
    await engine.scheduler.tick(clock.now);
    const replacementEpoch = registry.currentEpoch(WORKFLOW_ID);
    expect(replacementEpoch).toBe(2);
    // The old fire let go of its own record only: the replacement's claim, marker and queued start
    // are intact.
    expect(await observeWindow(engine)).toEqual({
      launching: true,
      queued: true,
      status: 'pending',
    });
    expect(await storage.get(KEYS.workflowOwnerHolder(WORKFLOW_ID))).not.toBeNull();

    // This engine's next reclaim pass finds the id held and queued under its claim, and defers; the
    // flush then drives the replacement once.
    const pass = await internals.workflowClaimRenewalTask!.runOnce();
    expect(pass.reclaim).toMatchObject({ status: 'completed' });
    await engine.flushInlineLaunches();
    await waitForCondition(() => probe.runs >= 1, { label: 'the replacement runs' });
    await letOtherDrivesStart();
    probe.hold.resolve();
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
    expect(events).toEqual({ started: 1, resumed: 0 });
    expect(registry.currentEpoch(WORKFLOW_ID)).toBeNull();
  });

  it('keeps a prepared replacement claim, which then launches and drives once', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'unavailable', reason: 'gone' }));
    resolver.release();
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;
    const probe = probeFor(storage);
    await engine.start('counted', null, {
      id: WORKFLOW_ID,
      startAt: START_AT,
      services: { owner: 'delayed' },
    });
    internals.workflowServices.delete(WORKFLOW_ID);
    clock.now = START_AT;

    // A prepared `start-new` replacement commits the next epoch in the same window and holds that
    // claim until its `launch()`, with no launching record yet. The old fire's let-go must release
    // only the epoch it recorded, or the replacement's own `launch()` finds itself deposed.
    let prepared: Awaited<ReturnType<typeof engine.prepare>> | undefined;
    const originalRelease = registry.release.bind(registry);
    registry.release = async (workflowId, expectedEpoch) => {
      const result = await originalRelease(workflowId, expectedEpoch);
      if (prepared === undefined && workflowId === WORKFLOW_ID) {
        prepared = await engine.prepare('counted', null, {
          id: WORKFLOW_ID,
          onTerminalConflict: 'start-new',
        });
      }
      return result;
    };
    await engine.scheduler.tick(clock.now);
    expect(registry.currentEpoch(WORKFLOW_ID)).toBe(2);
    expect(await storage.get(KEYS.workflowOwnerHolder(WORKFLOW_ID))).not.toBeNull();

    await prepared!.launch();
    await engine.flushInlineLaunches();
    await waitForCondition(() => probe.runs >= 1, { label: 'the replacement runs' });
    await letOtherDrivesStart();
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
  });
});

describe('a prepared start that stops short of its launch', () => {
  it('fails the run, settles the marker, and releases the claim when the failure commits', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'unavailable', reason: 'gone' }));
    resolver.release();
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    const probe = probeFor(storage);
    const prepared = await engine.prepare('counted', null, {
      id: WORKFLOW_ID,
      services: { owner: 'prepared' },
    });
    internals.workflowServices.delete(WORKFLOW_ID);
    const outcome = await prepared.launch().then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await engine.flushInlineLaunches();
    expect(outcome).toContain('could not be re-provided');
    expect(await statusOf(storage)).toBe('failed');
    expect(internals.inlineStrategy!.hasGenerator(WORKFLOW_ID)).toBe(false);
    expect(probe.runs).toBe(0);
    expect(internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID)).toBe(false);
    expect(internals.workflowClaimRegistry!.currentEpoch(WORKFLOW_ID)).toBeNull();
  });

  it('lets the run go when the failure commit faults, and the next reclaim pass fails it', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    const resolver = createResolver(() => ({ status: 'unavailable', reason: 'gone' }));
    resolver.release();
    await using engine = await createInlineEngine(storage, clock, {
      resolveWorkflowServices: resolver.option,
    });
    const internals = getInternals(engine);
    const probe = probeFor(storage);
    const prepared = await engine.prepare('counted', null, {
      id: WORKFLOW_ID,
      services: { owner: 'prepared' },
    });
    internals.workflowServices.delete(WORKFLOW_ID);
    storage.failNextFailedWrite = true;
    const outcome = await prepared.launch().then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    expect(outcome).not.toBe('resolved');
    expect(storage.failedWriteFaults).toBe(1);
    expect(await statusOf(storage)).toBe('running');
    expect(internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID)).toBe(false);
    expect(internals.workflowClaimRegistry!.currentEpoch(WORKFLOW_ID)).toBeNull();

    const pass = await internals.workflowClaimRenewalTask!.runOnce();
    expect(pass.reclaim).toMatchObject(RECLAIMED);
    await waitForCondition(async () => (await statusOf(storage)) === 'failed', {
      label: 'the next pass fails the run',
    });
    expect(probe.runs).toBe(0);
  });

  it('settles its marker once a worker has the run', async () => {
    const storage = new RacingStorage();
    const clock = createClock();
    await using engine = await createWorkerEngine(storage, clock);
    const internals = getInternals(engine);
    const events = countEvents(engine);
    const prepared = await engine.prepare('simple', null, { id: WORKFLOW_ID });
    const handle = await prepared.launch();
    const launchingAfterTheLaunch =
      internals.queuedOrLaunchingInlineWorkflowStartIds.has(WORKFLOW_ID);
    expect(await handle.result()).toEqual({ input: null, computed: 42 });
    expect(events.started).toBe(1);
    expect(launchingAfterTheLaunch).toBe(false);
  });
});
