/**
 * COR-1524 — the snapshot reference of a file agent's run is written only once the run is this
 * execution's, and every way the run can fail to start, lose its claim, or end without a handle
 * leaves nothing behind: no reference, and no snapshot that nothing holds. Each path has a test.
 *
 * The dispatcher runs against a fake runtime composition, as `bureau-catalog-dispatch.test.ts`
 * does, with a real snapshot store and a real file-agent catalog.
 */
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createCheckpointStore,
  readGenerationProfile,
  createRunEngine,
  createRunWorkflow,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AnyRunnableAgent } from './agent-catalog';
import { readFileAgentBinding } from './agent-file-catalog';
import { createFileAgentRuntime, type FileAgentRuntime } from './agent-file-runtime';
import { createAgentSnapshotStore, type AgentSnapshotStore } from './agent-snapshot-store';
import {
  createCatalogDispatcher,
  GoalAttemptInvalidCostEstimationError,
  GoalAttemptTombstonedError,
} from './bureau-catalog-dispatch';
import type { CatalogRunRecoveryLoad, RuntimeComposition } from './runtime-composition';
import type { RunAttribution } from './serialization';
import {
  type AgentFileFixture,
  createAgentFileFixture,
  validAgentFile,
} from './testing/agent-file-fixtures.test-support';

const fixtures: AgentFileFixture[] = [];
const disposers: Array<() => void> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

interface Harness {
  readonly fixture: AgentFileFixture;
  readonly snapshots: AgentSnapshotStore;
  readonly fileAgents: FileAgentRuntime;
  readonly runtimeServices: ManualRuntimeServices;
  /** The hash of the file as it is now. */
  readonly currentHash: string;
  /** A snapshot another run holds, as the winner of a claim would have recorded it. */
  holdElsewhere(runId: string, instructions: string): Promise<string>;
  /** A snapshot stored and held by no run, as a winner that died before it held one left it. */
  storeWithoutReference(instructions: string): Promise<string>;
  dispatcher(runtime: RuntimeComposition): ReturnType<typeof createCatalogDispatcher>;
}

async function harness(): Promise<Harness> {
  const fixture = await createAgentFileFixture({ watch: false });
  fixtures.push(fixture);
  await fixture.put('worker.md', validAgentFile('Current instructions.\n'));
  await fixture.catalog.refresh();
  const runtimeServices = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
  const snapshots = createAgentSnapshotStore({ nowISO: runtimeServices.clock.nowISO });
  const fileAgents = createFileAgentRuntime({
    files: fixture.catalog,
    snapshots,
    diagnose: (message, cause) => {
      throw new Error(`${message} ${String(cause)}`);
    },
    track: (promise, label) => runtimeServices.deferred.track(promise, label),
  });
  const agent = fixture.catalog.find('worker');
  if (agent === undefined) throw new Error('Expected the worker agent.');
  const binding = readFileAgentBinding(agent);
  if (binding === undefined) throw new Error('Expected a file agent.');
  return {
    fixture,
    snapshots,
    fileAgents,
    runtimeServices,
    currentHash: binding.hash,
    async holdElsewhere(runId, instructions) {
      const definition = { ...binding.definition, instructions };
      const hash = `held-${runId}`;
      await snapshots.recordRun({ id: 'worker', hash, definition }, runId);
      return hash;
    },
    async storeWithoutReference(instructions) {
      const definition = { ...binding.definition, instructions };
      const hash = `stored-${instructions.length}`;
      await snapshots.begin({ id: 'worker', hash, definition });
      return hash;
    },
    dispatcher: (runtime) =>
      createCatalogDispatcher({
        agentCatalog: { find: (name: string) => fixture.catalog.find(name) },
        runtime,
        runtimeServices,
        getShutdownPromise: () => undefined,
        catalogRuns: new Set(),
        runAttribution: new Map<string, RunAttribution>(),
        detachBestEffortPromise: () => {},
        createBureauError: (message, code) => Object.assign(new Error(message), { code }),
        validateAgentRunInput: () => {},
        onDurableRunAborted: () => {},
        fileAgents,
      }),
  };
}

/** A durable composition that stops at the claim: the run never reaches an engine. */
function claimRuntime(options: {
  readonly claim: () => Promise<boolean>;
  readonly persist?: () => Promise<void>;
  readonly load?: () => Promise<CatalogRunRecoveryLoad>;
}): RuntimeComposition {
  return {
    durable: { engine: {}, checkpointStore: {} },
    createBureauInvariantHooks: () => undefined,
    mediaOptionsFor: () => ({}),
    claimCatalogRunRecoveryRecord: options.claim,
    persistCatalogRunRecoveryRecord: options.persist ?? (async () => {}),
    loadCatalogRunRecoveryRecord: options.load ?? (async () => ({ status: 'missing' })),
  } as unknown as RuntimeComposition;
}

/** A durable composition over a real engine, so a run that wins its claim really starts. */
async function engineRuntime(
  overrides: Partial<Record<string, unknown>> = {},
): Promise<RuntimeComposition> {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const { engine } = await createRunEngine({
    storage,
    runWorkflow: createRunWorkflow(checkpointStore),
    recover: false,
  });
  disposers.push(() => engine[Symbol.dispose]());
  return {
    durable: { engine, checkpointStore },
    createBureauInvariantHooks: () => undefined,
    mediaOptionsFor: () => ({}),
    claimCatalogRunRecoveryRecord: async () => true,
    persistCatalogRunRecoveryRecord: async () => {},
    ...overrides,
  } as unknown as RuntimeComposition;
}

const attempt = {
  agentName: 'worker',
  input: 'work',
  runId: 'goal-g1-a0',
  goalRunId: 'g1',
  attemptIndex: 0,
};
const child = {
  agentName: 'worker',
  input: 'work',
  childRunId: 'child-1',
  context: {
    childCorrelation: {
      parentAgentName: 'planner',
      parentRunId: 'parent-1',
      childAgentName: 'worker',
      childRunId: 'child-1',
    },
  },
};

const settleOutcome = (started: { durablyStarted: Promise<void> }): Promise<unknown> =>
  started.durablyStarted.then(
    () => undefined,
    (error: unknown) => error,
  );

/** Let the settlement a handle's end starts reach the store: a few turns, then the tracked work. */
async function settled(h: Harness): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await h.runtimeServices.deferred.drain();
}

/** What is stored: the reference for `runId` and the snapshot keys. */
async function stored(snapshots: AgentSnapshotStore, runId: string, id = 'worker') {
  const reference = await snapshots.reference(runId);
  const revisions = await snapshots.revisions(id);
  return { reference, hashes: revisions.map((revision) => revision.hash).toSorted() };
}

describe('a claim this execution loses', () => {
  it('leaves the winner’s reference and snapshot alone, and keeps none of its own, for a child', async () => {
    const h = await harness();
    const winnerHash = await h.holdElsewhere('child-1', 'Winner’s instructions.\n');
    const before = await h.snapshots.reference('child-1');
    const dispatcher = h.dispatcher(claimRuntime({ claim: async () => false }));

    const result = await dispatcher.startChildRun({ ...child }).result();

    expect(String(result.error)).toContain('Run "child-1" already exists');
    expect(await stored(h.snapshots, 'child-1')).toEqual({
      reference: before,
      hashes: [winnerHash],
    });
  });

  it('does the same for a goal attempt whose claim another goal holds', async () => {
    const h = await harness();
    const winnerHash = await h.holdElsewhere(attempt.runId, 'Winner’s instructions.\n');
    const before = await h.snapshots.reference(attempt.runId);
    const dispatcher = h.dispatcher(
      claimRuntime({
        claim: async () => false,
        load: async () => ({
          status: 'found',
          record: {
            schemaVersion: 1,
            agentName: 'worker',
            definitionRevision: 1,
            input: 'work',
            goalAttempt: { goalRunId: 'other-goal', attemptIndex: 0 },
            costEstimation: null,
          },
        }),
      }),
    );

    const reason = await settleOutcome(dispatcher.startGoalAttemptRun(attempt));

    expect(String(reason)).toContain('does not belong to this goal attempt');
    expect(await stored(h.snapshots, attempt.runId)).toEqual({
      reference: before,
      hashes: [winnerHash],
    });
  });

  it('does the same for a claim the goal has tombstoned', async () => {
    const h = await harness();
    const winnerHash = await h.holdElsewhere(attempt.runId, 'Winner’s instructions.\n');
    const before = await h.snapshots.reference(attempt.runId);
    const dispatcher = h.dispatcher(
      claimRuntime({
        claim: async () => false,
        load: async () => ({
          status: 'found',
          record: {
            schemaVersion: 1,
            agentName: 'worker',
            definitionRevision: 1,
            input: 'work',
            goalAttempt: {
              goalRunId: attempt.goalRunId,
              attemptIndex: attempt.attemptIndex,
              tombstonedAt: '2026-10-18T00:00:00.000Z',
            },
            costEstimation: null,
          },
        }),
      }),
    );

    expect(await settleOutcome(dispatcher.startGoalAttemptRun(attempt))).toBeInstanceOf(
      GoalAttemptTombstonedError,
    );
    expect(await stored(h.snapshots, attempt.runId)).toEqual({
      reference: before,
      hashes: [winnerHash],
    });
  });

  it('continues the winner’s run on the winner’s snapshot, and drops its own', async () => {
    const h = await harness();
    const winnerHash = await h.holdElsewhere(attempt.runId, 'Winner’s instructions.\n');
    const runtime = await engineRuntime({
      claimCatalogRunRecoveryRecord: async () => false,
      loadCatalogRunRecoveryRecord: async () => ({
        status: 'found',
        record: {
          schemaVersion: 1,
          agentName: 'worker',
          definitionRevision: 1,
          input: 'work',
          agentDefinitionHash: winnerHash,
          goalAttempt: { goalRunId: attempt.goalRunId, attemptIndex: attempt.attemptIndex },
          costEstimation: null,
        },
      }),
    });

    const started = h.dispatcher(runtime).startGoalAttemptRun(attempt);
    await started.durablyStarted;
    await started.run.result();
    await settled(h);

    const { reference, hashes } = await stored(h.snapshots, attempt.runId);
    expect(reference?.hash).toBe(winnerHash);
    expect(hashes).toEqual([winnerHash]);
    expect(hashes).not.toContain(h.currentHash);
  });

  it('continues the winner’s run at the revision the winner’s claim recorded, not the catalog’s', async () => {
    const h = await harness();
    const winnerHash = await h.holdElsewhere(attempt.runId, 'Winner’s instructions.\n');
    expect(
      readGenerationProfile(h.fixture.catalog.find('worker') as AnyRunnableAgent).revision,
    ).toBe(1);
    const runtime = await engineRuntime({
      claimCatalogRunRecoveryRecord: async () => false,
      loadCatalogRunRecoveryRecord: async () => ({
        status: 'found',
        record: {
          schemaVersion: 1,
          agentName: 'worker',
          definitionRevision: 2,
          input: 'work',
          agentDefinitionHash: winnerHash,
          goalAttempt: { goalRunId: attempt.goalRunId, attemptIndex: attempt.attemptIndex },
          costEstimation: null,
        },
      }),
    });

    const started = h.dispatcher(runtime).startGoalAttemptRun(attempt);
    await started.durablyStarted;
    await started.run.result();
    await settled(h);

    const { reference } = await stored(h.snapshots, attempt.runId);
    expect(reference?.hash).toBe(winnerHash);
    expect(reference?.definitionRevision).toBe(2);
  });

  it('ties the winner’s snapshot to the run when the winner claimed and died before it held one', async () => {
    const h = await harness();
    const winnerHash = await h.storeWithoutReference('Winner’s instructions.\n');
    expect(await h.snapshots.reference(attempt.runId)).toBeUndefined();
    const runtime = await engineRuntime({
      claimCatalogRunRecoveryRecord: async () => false,
      loadCatalogRunRecoveryRecord: async () => ({
        status: 'found',
        record: {
          schemaVersion: 1,
          agentName: 'worker',
          definitionRevision: 1,
          input: 'work',
          agentDefinitionHash: winnerHash,
          goalAttempt: { goalRunId: attempt.goalRunId, attemptIndex: attempt.attemptIndex },
          costEstimation: null,
        },
      }),
    });

    const started = h.dispatcher(runtime).startGoalAttemptRun(attempt);
    await started.durablyStarted;
    // The continuation holds the winner's snapshot from the moment it starts, so a pass that
    // prunes snapshots nothing holds cannot take it from under the run.
    const tied = await h.snapshots.reference(attempt.runId);
    expect(tied?.hash).toBe(winnerHash);
    await started.run.result();
    await settled(h);

    const { reference, hashes } = await stored(h.snapshots, attempt.runId);
    expect(reference?.hash).toBe(winnerHash);
    expect(reference?.settledAt).toBeDefined();
    expect(hashes).toEqual([winnerHash]);
  });

  it('keeps nothing when the winner’s snapshot cannot be rebuilt', async () => {
    const h = await harness();
    const runtime = await engineRuntime({
      claimCatalogRunRecoveryRecord: async () => false,
      loadCatalogRunRecoveryRecord: async () => ({
        status: 'found',
        record: {
          schemaVersion: 1,
          agentName: 'worker',
          definitionRevision: 1,
          input: 'work',
          agentDefinitionHash: 'gone',
          goalAttempt: { goalRunId: attempt.goalRunId, attemptIndex: attempt.attemptIndex },
          costEstimation: null,
        },
      }),
    });

    const reason = await settleOutcome(h.dispatcher(runtime).startGoalAttemptRun(attempt));

    expect(reason).toMatchObject({ code: 'snapshot-missing' });
    expect(await stored(h.snapshots, attempt.runId)).toEqual({ reference: undefined, hashes: [] });
  });
});

describe('a start that fails before the run exists', () => {
  it('keeps nothing when the claim itself throws, for a fixed run id', async () => {
    const h = await harness();
    const dispatcher = h.dispatcher(
      claimRuntime({
        claim: async () => {
          throw new Error('claim write failed');
        },
      }),
    );

    expect(await settleOutcome(dispatcher.startGoalAttemptRun(attempt))).toMatchObject({
      message: 'claim write failed',
    });
    expect(await stored(h.snapshots, attempt.runId)).toEqual({ reference: undefined, hashes: [] });
  });

  it('keeps nothing when the recovery record cannot be written, for a child run', async () => {
    const h = await harness();
    const dispatcher = h.dispatcher(
      claimRuntime({
        claim: async () => true,
        persist: async () => {
          throw new Error('persist failed');
        },
      }),
    );

    const run = dispatcher.startChildRun({ ...child });
    const result = await run.result();

    expect(String(result.error)).toContain('persist failed');
    expect(await h.snapshots.unsettledReferences()).toEqual([]);
    const revisions = await h.snapshots.revisions('worker');
    expect(revisions.length).toBe(0);
  });
});

describe('a goal attempt whose agent cannot be persisted as a recovery record', () => {
  it('keeps no snapshot when its cost estimation is refused before the start is recorded', async () => {
    const h = await harness();
    const agent = h.fixture.catalog.find('worker') as unknown as Record<symbol, unknown>;
    const resolve = agent[OPERATIVE_RESOLVE_RUN_OPTIONS] as (
      input: unknown,
      context: unknown,
    ) => Promise<Record<string, unknown>>;
    // An estimation with a field the recovery record refuses: the attempt ends permanently.
    Object.defineProperty(agent, OPERATIVE_RESOLVE_RUN_OPTIONS, {
      value: (input: unknown, context: unknown) =>
        resolve
          .call(agent, input, context)
          .then((options) => ({ ...options, costEstimation: { model: 'm', extra: true } })),
    });
    const dispatcher = h.dispatcher(claimRuntime({ claim: async () => true }));

    const reason = await settleOutcome(dispatcher.startGoalAttemptRun(attempt));

    expect(reason).toBeInstanceOf(GoalAttemptInvalidCostEstimationError);
    expect(await stored(h.snapshots, attempt.runId)).toEqual({ reference: undefined, hashes: [] });
  });
});

describe('a run that wins its claim', () => {
  it('holds the snapshot from the claim, and settles it when the run ends', async () => {
    const h = await harness();
    const started = h.dispatcher(await engineRuntime()).startGoalAttemptRun(attempt);
    await started.durablyStarted;
    const held = await h.snapshots.reference(attempt.runId);
    expect(held?.hash).toBe(h.currentHash);
    await started.run.result();
    await settled(h);
    const ended = await h.snapshots.reference(attempt.runId);
    expect(ended?.settledAt).toBeDefined();
  });
});

describe('a run that is not durable', () => {
  const plain = {
    createBureauInvariantHooks: () => undefined,
    mediaOptionsFor: () => ({}),
  } as unknown as RuntimeComposition;

  it('settles its reference when it is aborted while it is still resolving', async () => {
    const h = await harness();
    const run = h.dispatcher(plain).startChildRun({ ...child });
    run.abort('changed my mind');
    await run.result();
    await settled(h);

    expect(await h.snapshots.unsettledReferences()).toEqual([]);
    const reference = await h.snapshots.reference(run.id);
    expect(reference?.settledAt).toBeDefined();
  });

  it('settles its reference when it runs to the end', async () => {
    const h = await harness();
    const run = h.dispatcher(plain).startChildRun({ ...child });
    await run.result();
    await settled(h);
    const ended = await h.snapshots.reference(run.id);
    expect(ended?.settledAt).toBeDefined();
  });
});
