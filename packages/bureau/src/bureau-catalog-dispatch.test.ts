/**
 * COR-772 — the catalog dispatcher's child-start guards. The child path is
 * otherwise exercised end to end through `bureau.children` in
 * `bureau-children.test.ts`; these are the refusals the topology never
 * reaches in normal operation, because it plans the child first and refuses
 * an identifier another run already holds before it starts anything.
 */
import {
  createDefaultRuntimeServices,
  createManualRuntimeServices,
  HookRegistry,
} from '@lostgradient/lifecycle';
import {
  AgentContractError,
  createAgent,
  createCheckpointStore,
  createRunEngine,
  createRunWorkflow,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type OperativeHookMap,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitionPin } from './agent-definition-pin';
import { composeRunHooks, type RunHookTiers } from './run-hook-tiers';
import {
  type CatalogRunEnded,
  createCatalogDispatcher,
  GoalAttemptInvalidCostEstimationError,
  DefinitionDriftedError,
  GoalAttemptNotDurableCapableError,
  GoalAttemptTombstonedError,
} from './bureau-catalog-dispatch';
import { registerGoalAttemptFence } from './goal-attempt-fence';
import type { RuntimeComposition } from './runtime-composition-types';
import type { RunAttribution } from './serialization';
import { lastPromptOf } from './testing/goal-fixtures.test-support';

/** What the runtime composition's `composeRunHooks` does, with no plugin contributing (COR-2127). */
const composeTestRunHooks = (tiers: RunHookTiers) => composeRunHooks(undefined, tiers);

function createDispatcher(
  shuttingDown: boolean,
  options: {
    readonly runtime?: RuntimeComposition;
    readonly runAttribution?: Map<string, RunAttribution>;
    readonly onCatalogRunEnded?: (ended: CatalogRunEnded) => void;
    /** What the catalog says the worker pins now (COR-2230); absent says nothing, as a file agent's. */
    readonly pin?: AgentDefinitionPin;
    /**
     * What the store holds, which the catalog's `pin` is until the dispatcher reloads the agent's
     * overrides from it: a Bureau that never reloaded after another saved holds the older one.
     */
    readonly pinAfterReload?: AgentDefinitionPin;
    /** Receives the name of each agent whose overrides the dispatcher reloaded. */
    readonly reloads?: string[];
  } = {},
) {
  const worker = createAgent({
    name: 'worker',
    generate: async () => ({ content: 'done', toolCalls: [] }),
    stopWhen: stopWhen.noToolCalls(),
  });
  let pin = options.pin;
  return createCatalogDispatcher({
    agentCatalog: {
      find: (name: string) => (name === 'worker' ? worker : undefined),
      definitionPin: (name: string) => (name === 'worker' ? pin : undefined),
      overrides: {
        reload: async (name: string) => {
          options.reloads?.push(name);
          if (options.pinAfterReload !== undefined) pin = options.pinAfterReload;
        },
      } as never,
    },
    // The first two refusals never reach the runtime composition.
    runtime: options.runtime ?? ({} as RuntimeComposition),
    runtimeServices: createManualRuntimeServices(),
    getShutdownPromise: () => (shuttingDown ? Promise.resolve() : undefined),
    catalogRuns: new Set(),
    runAttribution: options.runAttribution ?? new Map(),
    detachBestEffortPromise: () => {},
    createBureauError: (message, code) => Object.assign(new Error(message), { code }),
    validateAgentRunInput: () => {},
    onDurableRunAborted: () => {},
    ...(options.onCatalogRunEnded === undefined
      ? {}
      : { onCatalogRunEnded: options.onCatalogRunEnded }),
  });
}

/** Just enough of a durable composition to reach the recovery-record write. */
function durableRuntime(claimed: boolean): RuntimeComposition {
  return {
    durable: { engine: {}, checkpointStore: {} },
    createBureauInvariantHooks: () => undefined,
    composeRunHooks: composeTestRunHooks,
    mediaOptionsFor: () => ({}),
    withChatPermission: (toolbox: unknown) => toolbox,
    holdToModelPolicy: (options: unknown) => options,
    claimCatalogRunRecoveryRecord: async () => claimed,
    persistCatalogRunRecoveryRecord: () => {
      throw new Error('a child never overwrites a recovery record');
    },
  } as unknown as RuntimeComposition;
}

const start = {
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
  taskOrigin: { kind: 'agent' as const, parentRunId: 'parent-1', agentName: 'planner' },
};

describe('createCatalogDispatcher — startChildRun', () => {
  it('refuses to start a child once the bureau is shutting down', () => {
    expect(() => createDispatcher(true).startChildRun({ ...start, agentName: 'worker' })).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
  });

  it('refuses a run identifier another run is already attributed under, and leaves it attributed', () => {
    const runAttribution = new Map([['child-1', { agentName: 'worker', principal: 'alice' }]]);
    const dispatcher = createDispatcher(false, { runtime: durableRuntime(true), runAttribution });

    expect(() =>
      dispatcher.startChildRun({ ...start, agentName: 'worker', principal: 'mallory' }),
    ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(runAttribution.get('child-1')).toEqual({ agentName: 'worker', principal: 'alice' });
  });

  it('fails a child whose recovery record another run already holds, and drops its own attribution', async () => {
    const runAttribution = new Map<string, RunAttribution>();
    const dispatcher = createDispatcher(false, { runtime: durableRuntime(false), runAttribution });

    const run = dispatcher.startChildRun({ ...start, agentName: 'worker', principal: 'mallory' });
    const result = await run.result();

    expect(result.finishReason).toBe('error');
    expect(String(result.error)).toContain('Run "child-1" already exists');
    expect(runAttribution.has('child-1')).toBe(false);
  });

  it('gives a process-local child handle the id the topology recorded for it (COR-1302)', async () => {
    const dispatcher = createDispatcher(false, {
      runtime: {
        createBureauInvariantHooks: () => undefined,
        composeRunHooks: composeTestRunHooks,
        mediaOptionsFor: () => ({}),
        withChatPermission: (toolbox: unknown) => toolbox,
        holdToModelPolicy: (options: unknown) => options,
      } as unknown as RuntimeComposition,
    });

    const run = dispatcher.startChildRun({ ...start, agentName: 'worker' });
    expect(run.id).toBe('child-1');
    expect(run.snapshot().id).toBe('child-1');
    const result = await run.result();
    expect(result.error).toBeUndefined();
    expect(result.content).toBe('done');
    expect(run.id).toBe('child-1');
    expect(run.snapshot().id).toBe('child-1');
  });

  // COR-2106 — an agent with no `OPERATIVE_RESOLVE_RUN_OPTIONS` could only run without Bureau's
  // hooks, so it is refused before the child has a handle, an attribution or a run.
  it('refuses a child whose agent has no run-options resolver with an error naming it, and starts nothing', () => {
    let runs = 0;
    const resolverless = {
      name: 'worker',
      hasOutput: false,
      run: () => {
        runs += 1;
        return undefined as never;
      },
    };
    const runAttribution = new Map<string, RunAttribution>();
    const dispatcher = createCatalogDispatcher({
      agentCatalog: { find: (name: string) => (name === 'worker' ? resolverless : undefined) },
      runtime: {} as RuntimeComposition,
      runtimeServices: createManualRuntimeServices(),
      getShutdownPromise: () => undefined,
      catalogRuns: new Set(),
      runAttribution,
      detachBestEffortPromise: () => {},
      createBureauError: (message, code) => Object.assign(new Error(message), { code }),
      validateAgentRunInput: () => {},
      onDurableRunAborted: () => {},
    });

    expect(() => dispatcher.startChildRun({ ...start, agentName: 'worker' })).toThrow(
      expect.objectContaining({
        name: 'AgentContractError',
        message: expect.stringContaining('Agent "worker" exposes no run-options resolver'),
      }),
    );
    expect(runs).toBe(0);
    expect(runAttribution.size).toBe(0);
  });

  it('refuses to start a child for an agent the catalog does not have', () => {
    const dispatcher = createDispatcher(false);

    expect(dispatcher.planChildRun('nobody')).toBeUndefined();
    expect(() => dispatcher.startChildRun({ ...start, agentName: 'nobody' })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});

/**
 * COR-2005 — once shutdown has closed admission, no kind of subordinate run starts, so none is
 * followed to a settlement the shutdown could miss. These hold on `main` already: the refusal is
 * why a late settlement can only come from a run that started before the shutdown.
 */
describe('createCatalogDispatcher — starts after shutdown began', () => {
  it('refuses a goal attempt', () => {
    expect(() =>
      createDispatcher(true).startGoalAttemptRun({
        agentName: 'worker',
        input: 'work',
        runId: 'goal-g1-a0',
        goalRunId: 'g1',
        attemptIndex: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('refuses a workflow step', () => {
    expect(() =>
      createDispatcher(true).startWorkflowStepRun({
        agentName: 'worker',
        input: 'work',
        runId: 'workflow-w1-s0',
        workflowStep: { workflowId: 'w1', step: 0 },
      }),
    ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });
});

const realRuntime = createDefaultRuntimeServices();

const settle = (started: { durablyStarted: Promise<void> }) =>
  started.durablyStarted.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('createCatalogDispatcher — startGoalAttemptRun', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });
  const attempt = {
    agentName: 'worker',
    input: 'work',
    runId: 'goal-g1-a0',
    goalRunId: 'g1',
    attemptIndex: 0,
  };

  it("settles durablyStarted only once the attempt's workflow is in the engine", async () => {
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
    const runtime = {
      durable: { engine, checkpointStore },
      createBureauInvariantHooks: () => undefined,
      composeRunHooks: composeTestRunHooks,
      mediaOptionsFor: () => ({}),
      withChatPermission: (toolbox: unknown) => toolbox,
      holdToModelPolicy: (options: unknown) => options,
      claimCatalogRunRecoveryRecord: async () => true,
      persistCatalogRunRecoveryRecord: async () => {},
    } as unknown as RuntimeComposition;

    const started = createDispatcher(false, { runtime }).startGoalAttemptRun(attempt);
    // The handle is deferred: the workflow does not exist when it is returned.
    expect(await engine.get(attempt.runId)).toBeNull();

    await started.durablyStarted;

    expect(await engine.get(attempt.runId)).not.toBeNull();
    await started.run.result();
  });

  it('rejects durablyStarted with what stopped the start, so no goal waits on a run that never existed', async () => {
    const runtime = {
      ...durableRuntime(true),
      claimCatalogRunRecoveryRecord: async () => {
        throw new Error('recovery record write failed');
      },
    } as unknown as RuntimeComposition;

    const started = createDispatcher(false, { runtime }).startGoalAttemptRun(attempt);

    expect(
      await started.durablyStarted.then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toEqual(expect.objectContaining({ message: 'recovery record write failed' }));
  });

  it('never runs the agent directly when a lazy agent turns out not to resolve durably', async () => {
    // A lazy-wrapped agent only discovers, once invoked, that its module cannot
    // resolve run options. An ordinary run falls back to the agent's own `run()`;
    // a goal attempt must not, since that run is untracked and a retry would
    // launch a second one.
    let ranDirectly = 0;
    const lazy = {
      name: 'worker',
      hasOutput: false,
      run: () => {
        ranDirectly += 1;
        throw new Error('a goal attempt must never run the agent directly');
      },
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: () => {
        throw new AgentContractError('This agent does not support durable resolution.');
      },
    };
    const runtime = {
      durable: { engine: {}, checkpointStore: {} },
      createBureauInvariantHooks: () => undefined,
      composeRunHooks: composeTestRunHooks,
      mediaOptionsFor: () => ({}),
      withChatPermission: (toolbox: unknown) => toolbox,
      holdToModelPolicy: (options: unknown) => options,
      claimCatalogRunRecoveryRecord: async () => true,
      persistCatalogRunRecoveryRecord: async () => {},
    } as unknown as RuntimeComposition;
    const runAttribution = new Map<string, RunAttribution>();
    const dispatcher = createCatalogDispatcher({
      agentCatalog: { find: () => lazy as never },
      runtime,
      runtimeServices: createManualRuntimeServices(),
      getShutdownPromise: () => undefined,
      catalogRuns: new Set(),
      runAttribution,
      detachBestEffortPromise: () => {},
      createBureauError: (message, code) => Object.assign(new Error(message), { code }),
      validateAgentRunInput: () => {},
      onDurableRunAborted: () => {},
    });

    const started = dispatcher.startGoalAttemptRun(attempt);
    const reason = await started.durablyStarted.then(
      () => undefined,
      (error: unknown) => error,
    );
    const result = await started.run.result();

    expect(reason).toBeInstanceOf(GoalAttemptNotDurableCapableError);
    expect(ranDirectly).toBe(0);
    expect(result.finishReason).toBe('error');
  });

  describe('a start whose first execution outlived its start timeout', () => {
    /** A resolver that never answers on its first call, as a hung one does, and resolves normally after. */
    async function hungFirstResolver(
      runtimeOverrides: Record<string, unknown> = {},
      /** What the catalog pins the worker as now (COR-2230). */
      pin?: AgentDefinitionPin,
    ) {
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
      const worker = createAgent({
        name: 'worker',
        generate: async () => ({ content: 'done', toolCalls: [] }),
        stopWhen: stopWhen.noToolCalls(),
      });
      let calls = 0;
      let failFirst: (error: unknown) => void = () => {};
      const firstResolver = new Promise<never>((_resolve, reject) => {
        failFirst = reject;
      });
      const agent = new Proxy(worker, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property !== OPERATIVE_RESOLVE_RUN_OPTIONS || typeof value !== 'function') {
            return value;
          }
          return (...resolverArguments: unknown[]) => {
            calls += 1;
            return calls === 1
              ? firstResolver
              : (Reflect.apply(value, target, resolverArguments) as unknown);
          };
        },
      });
      const runtime = {
        durable: { engine, checkpointStore },
        createBureauInvariantHooks: () => undefined,
        composeRunHooks: composeTestRunHooks,
        mediaOptionsFor: () => ({}),
        withChatPermission: (toolbox: unknown) => toolbox,
        holdToModelPolicy: (options: unknown) => options,
        claimCatalogRunRecoveryRecord: async () => true,
        persistCatalogRunRecoveryRecord: async () => {},
        ...runtimeOverrides,
      } as unknown as RuntimeComposition;
      const runAttribution = new Map<string, RunAttribution>();
      const dispatcher = createCatalogDispatcher({
        agentCatalog: { find: () => agent as never, definitionPin: () => pin },
        runtime,
        runtimeServices: createManualRuntimeServices(),
        getShutdownPromise: () => undefined,
        catalogRuns: new Set(),
        runAttribution,
        detachBestEffortPromise: () => {},
        createBureauError: (message, code) => Object.assign(new Error(message), { code }),
        validateAgentRunInput: () => {},
        onDurableRunAborted: () => {},
      });
      return { dispatcher, engine, runAttribution, failFirst };
    }

    it('D4 (COR-2230): refuses the retry as drifted when the claim it reaches recorded another version, and leaves the older hold', async () => {
      const { dispatcher, runAttribution, failFirst } = await hungFirstResolver(
        {
          claimCatalogRunRecoveryRecord: async () => false,
          loadCatalogRunRecoveryRecord: async () => ({
            status: 'found',
            record: {
              schemaVersion: 1,
              definitionRevision: 1,
              input: 'work',
              agentName: 'worker',
              principal: 'alice',
              goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
              agentPluginVersion: '1.0.0',
              agentOverrideHash: 'hash-b',
            },
          }),
        },
        { agentPluginVersion: '1.1.0', agentOverrideHash: 'hash-b' },
      );
      const older = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      const retry = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });

      const error = await settle(retry);

      expect(error).toBeInstanceOf(DefinitionDriftedError);
      expect((error as Error).message).toMatch(/version was 1\.0\.0 and is now 1\.1\.0/);
      // The retry let go of its share only: the older execution still holds the attribution.
      expect(runAttribution.has(attempt.runId)).toBe(true);
      failFirst(new Error('the older resolver failed late'));
      await settle(older);
      expect(runAttribution.has(attempt.runId)).toBe(false);
    });

    it('lets the retry of the same attempt, agent, and principal reach the claim and start the workflow', async () => {
      const { dispatcher, engine, runAttribution } = await hungFirstResolver();

      // The first execution recorded its attribution and never got past its resolver.
      void dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      expect(runAttribution.get(attempt.runId)).toEqual({
        agentName: 'worker',
        principal: 'alice',
      });

      const retry = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      await retry.durablyStarted;

      expect(await engine.get(attempt.runId)).not.toBeNull();
      await retry.run.result();
    });

    it('lets the retry of an attempt whose goal states no principal reach the claim, under anonymous:local', async () => {
      const { dispatcher, engine, runAttribution } = await hungFirstResolver();

      // A goal recorded before owners existed has no principal; its attempts are owned
      // by anonymous:local, and the retry must recognize the attribution it recorded.
      void dispatcher.startGoalAttemptRun({ ...attempt });
      expect(runAttribution.get(attempt.runId)).toEqual({
        agentName: 'worker',
        principal: 'anonymous:local',
      });

      const retry = dispatcher.startGoalAttemptRun({ ...attempt });
      await retry.durablyStarted;

      expect(await engine.get(attempt.runId)).not.toBeNull();
      await retry.run.result();
    });

    it('keeps the retry’s attribution when the older execution fails after the retry took over', async () => {
      const { dispatcher, runAttribution, failFirst } = await hungFirstResolver();
      const older = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      const retry = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      await retry.durablyStarted;
      const held = runAttribution.get(attempt.runId);

      failFirst(new Error('the older resolver failed late'));
      expect(await settle(older)).toEqual(expect.objectContaining({ message: expect.any(String) }));

      // The retry's workflow is live: its owner's attribution is still held, by the
      // very object the retry holds, so a foreign principal is still refused.
      expect(runAttribution.get(attempt.runId)).toBe(held);
      expect(held).toEqual({ agentName: 'worker', principal: 'alice' });
      await retry.run.result();
    });

    it('drops the attribution once every execution holding it has failed', async () => {
      const { dispatcher, runAttribution, failFirst } = await hungFirstResolver({
        claimCatalogRunRecoveryRecord: async () => {
          throw new Error('claim write failed');
        },
      });
      const older = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      const retry = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      expect(await settle(retry)).toBeInstanceOf(Error);
      // The retry's failure leaves the older execution's hold in place.
      expect(runAttribution.has(attempt.runId)).toBe(true);

      failFirst(new Error('the older resolver failed late'));
      await settle(older);

      expect(runAttribution.has(attempt.runId)).toBe(false);
    });

    it.each([
      ['another principal', { ...attempt, principal: 'mallory' }],
      ['another attempt of the goal', { ...attempt, principal: 'alice', attemptIndex: 1 }],
      ['another goal', { ...attempt, principal: 'alice', goalRunId: 'g2' }],
    ])('still refuses %s under the attempt’s run id', async (_label, other) => {
      const { dispatcher, runAttribution } = await hungFirstResolver();
      void dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });

      expect(() => dispatcher.startGoalAttemptRun(other)).toThrow(
        expect.objectContaining({ code: 'CONFLICT' }),
      );
      expect(runAttribution.get(attempt.runId)).toEqual({
        agentName: 'worker',
        principal: 'alice',
      });
    });

    it('still refuses an attribution an ordinary run holds, whatever agent and principal it names', async () => {
      const { dispatcher, runAttribution } = await hungFirstResolver();
      runAttribution.set(attempt.runId, { agentName: 'worker', principal: 'alice' });

      expect(() => dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' })).toThrow(
        expect.objectContaining({ code: 'CONFLICT' }),
      );
    });
  });

  describe('a claim already holding the attempt id', () => {
    const conflicting = (record: Record<string, unknown> | undefined) => {
      const persisted: unknown[] = [];
      const runtime = {
        durable: { engine: {}, checkpointStore: {} },
        createBureauInvariantHooks: () => undefined,
        composeRunHooks: composeTestRunHooks,
        mediaOptionsFor: () => ({}),
        withChatPermission: (toolbox: unknown) => toolbox,
        holdToModelPolicy: (options: unknown) => options,
        claimCatalogRunRecoveryRecord: async () => false,
        loadCatalogRunRecoveryRecord: async () =>
          record === undefined
            ? { status: 'missing' }
            : {
                status: 'found',
                record: { schemaVersion: 1, definitionRevision: 1, input: 'work', ...record },
              },
        persistCatalogRunRecoveryRecord: async (_runId: string, written: unknown) => {
          persisted.push(written);
        },
      } as unknown as RuntimeComposition;
      return { runtime, persisted };
    };
    it.each([
      [
        'a claim another goal holds',
        { agentName: 'worker', goalAttempt: { goalRunId: 'g2', attemptIndex: 0 } },
      ],
      [
        'a claim for another attempt',
        { agentName: 'worker', goalAttempt: { goalRunId: 'g1', attemptIndex: 4 } },
      ],
      ["an ordinary run's record", { agentName: 'worker' }],
      [
        "another principal's claim",
        {
          agentName: 'worker',
          principal: 'mallory',
          goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
        },
      ],
      ['no record at all', undefined],
    ])('refuses to overwrite %s', async (_label, record) => {
      const { runtime, persisted } = conflicting(record);

      const error = await settle(createDispatcher(false, { runtime }).startGoalAttemptRun(attempt));

      expect(error).toEqual(expect.objectContaining({ code: 'CONFLICT' }));
      expect(persisted).toEqual([]);
    });

    it('starts nothing from its own claim once the goal has tombstoned it', async () => {
      const { runtime, persisted } = conflicting({
        agentName: 'worker',
        goalAttempt: { goalRunId: 'g1', attemptIndex: 0, tombstonedAt: '2026-10-02T12:00:00.000Z' },
      });
      const runAttribution = new Map<string, RunAttribution>();

      const error = await settle(
        createDispatcher(false, { runtime, runAttribution }).startGoalAttemptRun(attempt),
      );

      // Refused before the engine is asked for a workflow (the engine here has no `start`).
      expect(error).toBeInstanceOf(GoalAttemptTombstonedError);
      expect(persisted).toEqual([]);
      expect(runAttribution.has(attempt.runId)).toBe(false);
    });

    /**
     * COR-2230 — a second execution of the attempt reaches its own claim after the code agent moved.
     * The pin the claim recorded is compared with what the catalog pins now: refused on a
     * difference in either value, adopted on none, and a claim from before the pin is adopted as it
     * always was. The tombstone is checked first.
     */
    const NOW: AgentDefinitionPin = { agentPluginVersion: '1.1.0', agentOverrideHash: 'hash-b' };
    const OWN = { agentName: 'worker', goalAttempt: { goalRunId: 'g1', attemptIndex: 0 } };
    it.each([
      [
        'the plugin version moved',
        { ...OWN, agentPluginVersion: '1.0.0', agentOverrideHash: 'hash-b' },
        /version was 1\.0\.0 and is now 1\.1\.0/,
      ],
      [
        'the overrides moved',
        { ...OWN, agentPluginVersion: '1.1.0', agentOverrideHash: 'hash-a' },
        /overrides hashed hash-a and now hash hash-b/,
      ],
      [
        'the agent gained a version after a claim with none',
        { ...OWN, agentOverrideHash: 'hash-b' },
        /version was none and is now 1\.1\.0/,
      ],
    ])('refuses its own claim after %s, and starts nothing', async (_label, record, message) => {
      const { runtime, persisted } = conflicting(record);
      const runAttribution = new Map<string, RunAttribution>();

      const error = await settle(
        createDispatcher(false, { runtime, runAttribution, pin: NOW }).startGoalAttemptRun(attempt),
      );

      // Refused before the engine is asked for a workflow (the engine here has no `start`).
      expect(error).toBeInstanceOf(DefinitionDriftedError);
      expect((error as Error).message).toContain('definition-drifted');
      expect((error as Error).message).toMatch(message);
      expect(persisted).toEqual([]);
      expect(runAttribution.has(attempt.runId)).toBe(false);
    });

    it.each([
      [
        'a claim that records the same pin',
        { ...OWN, agentPluginVersion: '1.1.0', agentOverrideHash: 'hash-b' },
      ],
      ['a claim written before the pin existed', OWN],
    ])('does not refuse %s as drifted', async (_label, record) => {
      const { runtime } = conflicting(record);

      const error = await settle(
        createDispatcher(false, { runtime, pin: NOW }).startGoalAttemptRun(attempt),
      );

      expect(error).not.toBeInstanceOf(DefinitionDriftedError);
    });

    /**
     * COR-2230 — the claim may be another Bureau's. This catalog's pin is what it loaded at boot
     * until the dispatcher reads the store, so the comparison is made against the store's.
     */
    it.each([
      [
        'a claim that records what the store now holds is adopted, though this catalog held the older overrides',
        { ...OWN, agentPluginVersion: '1.1.0', agentOverrideHash: 'hash-b' },
        { agentPluginVersion: '1.1.0', agentOverrideHash: 'hash-a' },
        false,
      ],
      [
        'a claim that records what this catalog held is refused when the store has moved on',
        { ...OWN, agentPluginVersion: '1.1.0', agentOverrideHash: 'hash-a' },
        { agentPluginVersion: '1.1.0', agentOverrideHash: 'hash-a' },
        true,
      ],
    ])('compares %s', async (_label, record, stale, refused) => {
      const { runtime } = conflicting(record);
      const reloads: string[] = [];

      const error = await settle(
        createDispatcher(false, {
          runtime,
          pin: stale,
          pinAfterReload: NOW,
          reloads,
        }).startGoalAttemptRun(attempt),
      );

      expect(reloads).toEqual(['worker']);
      if (refused) expect(error).toBeInstanceOf(DefinitionDriftedError);
      else expect(error).not.toBeInstanceOf(DefinitionDriftedError);
    });

    /**
     * COR-2230 matrix rows D3 and D4: the drift refusal also holds when the engine already has a
     * workflow for the run (a second execution of an attempt or step whose first got that far), and
     * when the second execution is the retry of a start whose first outlived its start timeout.
     * Either way the claim's own pin is what is compared, and nothing is started.
     */
    describe.each([
      [
        'a goal attempt',
        (dispatcher: ReturnType<typeof createDispatcher>) =>
          dispatcher.startGoalAttemptRun(attempt),
        { goalAttempt: { goalRunId: 'g1', attemptIndex: 0 } },
      ],
      [
        'a workflow step',
        (dispatcher: ReturnType<typeof createDispatcher>) => {
          const step = dispatcher.startWorkflowStepRun({
            agentName: 'worker',
            input: 'work',
            runId: 'wf-w1-s0',
            workflowStep: { workflowId: 'w1', step: 0 },
          });
          return {
            durablyStarted: step.result().then((result) => {
              if (result.error !== undefined) throw result.error;
            }),
          };
        },
        { workflowStep: { workflowId: 'w1', step: 0 } },
      ],
    ])('%s', (_kind, startOf, owner) => {
      const claim = { agentName: 'worker', ...owner };
      const drifted = { ...claim, agentPluginVersion: '1.0.0', agentOverrideHash: 'hash-b' };

      it('D3: refuses a claim whose workflow the engine already holds, and asks the engine for nothing', async () => {
        const asked: string[] = [];
        const { runtime } = conflicting(drifted);
        (runtime as unknown as { durable: unknown }).durable = {
          engine: {
            get: async () => {
              asked.push('get');
              return { id: 'goal-g1-a0', status: 'running' };
            },
            start: async () => {
              asked.push('start');
              throw new Error('the workflow already exists');
            },
          },
          checkpointStore: {},
        };

        const error = await settle(startOf(createDispatcher(false, { runtime, pin: NOW })));

        expect(String(error)).toContain('definition-drifted');
        expect(String(error)).toMatch(/version was 1\.0\.0 and is now 1\.1\.0/);
        expect(asked).toEqual([]);
      });

      it('D3: does not refuse the same claim as drifted when nothing moved', async () => {
        const { runtime } = conflicting({ ...drifted, agentPluginVersion: '1.1.0' });

        const error = await settle(startOf(createDispatcher(false, { runtime, pin: NOW })));

        expect(String(error)).not.toContain('definition-drifted');
      });
    });

    /**
     * COR-2230 row A2: a start that writes a recovery record writes the pin the catalog holds. The
     * `bureau.run` dispatch that wrote it with no run id of its own went with COR-1707 (it is
     * `tasks.start`, a session run, whose pin is tested in `plugin-agent-drift.test.ts`), so the
     * record is written by a child, a goal attempt or a workflow step.
     */
    it.each([
      [
        'a child run',
        (dispatcher: ReturnType<typeof createDispatcher>) =>
          dispatcher.startChildRun({ ...start, agentName: 'worker' }).result(),
      ],
      [
        'a workflow step',
        (dispatcher: ReturnType<typeof createDispatcher>) =>
          dispatcher
            .startWorkflowStepRun({
              agentName: 'worker',
              input: 'work',
              runId: 'wf-w1-s0',
              workflowStep: { workflowId: 'w1', step: 0 },
            })
            .result(),
      ],
    ])(
      'A2: %s writes the plugin version and overrides hash into its record',
      async (_kind, run) => {
        const records: Record<string, unknown>[] = [];
        const runtime = {
          durable: { engine: {}, checkpointStore: {} },
          createBureauInvariantHooks: () => undefined,
          composeRunHooks: composeTestRunHooks,
          mediaOptionsFor: () => ({}),
          withChatPermission: (toolbox: unknown) => toolbox,
          holdToModelPolicy: (options: unknown) => options,
          claimCatalogRunRecoveryRecord: async (
            _runId: string,
            record: Record<string, unknown>,
          ) => {
            records.push(record);
            throw new Error('stop after the record');
          },
        } as unknown as RuntimeComposition;

        await run(createDispatcher(false, { runtime, pin: NOW }));

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          agentPluginVersion: '1.1.0',
          agentOverrideHash: 'hash-b',
        });
      },
    );

    it('takes the tombstone before the drift', async () => {
      const { runtime } = conflicting({
        agentName: 'worker',
        agentPluginVersion: '1.0.0',
        agentOverrideHash: 'hash-b',
        goalAttempt: { goalRunId: 'g1', attemptIndex: 0, tombstonedAt: '2026-10-02T12:00:00.000Z' },
      });

      const error = await settle(
        createDispatcher(false, { runtime, pin: NOW }).startGoalAttemptRun(attempt),
      );

      expect(error).toBeInstanceOf(GoalAttemptTombstonedError);
    });

    it('writes the pin into the claim it makes', async () => {
      const claims: Record<string, unknown>[] = [];
      const runtime = {
        durable: { engine: {}, checkpointStore: {} },
        createBureauInvariantHooks: () => undefined,
        composeRunHooks: composeTestRunHooks,
        mediaOptionsFor: () => ({}),
        withChatPermission: (toolbox: unknown) => toolbox,
        holdToModelPolicy: (options: unknown) => options,
        claimCatalogRunRecoveryRecord: async (_runId: string, record: Record<string, unknown>) => {
          claims.push(record);
          throw new Error('stop after the claim');
        },
      } as unknown as RuntimeComposition;

      await settle(createDispatcher(false, { runtime, pin: NOW }).startGoalAttemptRun(attempt));

      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({ agentPluginVersion: '1.1.0', agentOverrideHash: 'hash-b' });
    });

    it('writes the pin of the overrides the store holds, though this catalog loaded older ones at boot', async () => {
      const claims: Record<string, unknown>[] = [];
      const runtime = {
        durable: { engine: {}, checkpointStore: {} },
        createBureauInvariantHooks: () => undefined,
        composeRunHooks: composeTestRunHooks,
        mediaOptionsFor: () => ({}),
        withChatPermission: (toolbox: unknown) => toolbox,
        holdToModelPolicy: (options: unknown) => options,
        claimCatalogRunRecoveryRecord: async (_runId: string, record: Record<string, unknown>) => {
          claims.push(record);
          throw new Error('stop after the claim');
        },
      } as unknown as RuntimeComposition;
      const reloads: string[] = [];

      await settle(
        createDispatcher(false, {
          runtime,
          pin: { agentPluginVersion: '1.1.0', agentOverrideHash: 'hash-a' },
          pinAfterReload: NOW,
          reloads,
        }).startGoalAttemptRun(attempt),
      );

      expect(reloads).toEqual(['worker']);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({ agentPluginVersion: '1.1.0', agentOverrideHash: 'hash-b' });
    });

    it('writes only the override hash for a built-in agent, and neither field for a file agent', async () => {
      const claimsFor = async (pin: AgentDefinitionPin | undefined) => {
        const claims: Record<string, unknown>[] = [];
        const runtime = {
          durable: { engine: {}, checkpointStore: {} },
          createBureauInvariantHooks: () => undefined,
          composeRunHooks: composeTestRunHooks,
          mediaOptionsFor: () => ({}),
          withChatPermission: (toolbox: unknown) => toolbox,
          holdToModelPolicy: (options: unknown) => options,
          claimCatalogRunRecoveryRecord: async (
            _runId: string,
            record: Record<string, unknown>,
          ) => {
            claims.push(record);
            throw new Error('stop after the claim');
          },
        } as unknown as RuntimeComposition;
        await settle(
          createDispatcher(false, {
            runtime,
            ...(pin === undefined ? {} : { pin }),
          }).startGoalAttemptRun(attempt),
        );
        return claims[0] ?? {};
      };

      const builtIn = await claimsFor({ agentOverrideHash: 'hash-b' });
      expect(builtIn).toMatchObject({ agentOverrideHash: 'hash-b' });
      expect(builtIn).not.toHaveProperty('agentPluginVersion');
      const file = await claimsFor(undefined);
      expect(file).not.toHaveProperty('agentPluginVersion');
      expect(file).not.toHaveProperty('agentOverrideHash');
    });

    it('adopts its own claim as it stands and never rewrites it', async () => {
      const { runtime, persisted } = conflicting({
        agentName: 'worker',
        goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
      });

      await settle(createDispatcher(false, { runtime }).startGoalAttemptRun(attempt));

      // The winning claim is immutable: a loser of the claim race adopts it, so
      // the record can only ever describe the execution that wins the workflow.
      expect(persisted).toEqual([]);
    });
  });

  describe('a start the goal ended over after it claimed the run and before the engine created it', () => {
    /**
     * The claim is written, then the goal's ending tombstones it, then the
     * engine creates the workflow: the window no check from outside can close.
     * The run it creates must refuse its first step.
     */
    async function overtakenStart() {
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
      let tombstoned = false;
      let generates = 0;
      const worker = createAgent({
        name: 'worker',
        generate: async () => {
          generates += 1;
          return { content: 'done', toolCalls: [] };
        },
        stopWhen: stopWhen.noToolCalls(),
      });
      const fenceTargets: unknown[] = [];
      const runtime = {
        durable: { engine, checkpointStore },
        mediaOptionsFor: () => ({}),
        withChatPermission: (toolbox: unknown) => toolbox,
        holdToModelPolicy: (options: unknown) => options,
        // What the runtime composition does for a goal attempt's run.
        createBureauInvariantHooks: (goalAttempt?: { goalRunId: string }) => {
          const hooks = new HookRegistry<OperativeHookMap>({ source: 'bureau' });
          if (goalAttempt !== undefined) {
            fenceTargets.push(goalAttempt);
            registerGoalAttemptFence(
              hooks,
              { mayRun: () => Promise.resolve({ status: tombstoned ? 'refuse' : 'run' }) },
              goalAttempt as never,
            );
          }
          return hooks;
        },
        composeRunHooks: composeTestRunHooks,
        claimCatalogRunRecoveryRecord: async () => {
          // The claim lands, and the goal's ending tombstones it before the engine starts.
          tombstoned = true;
          return true;
        },
        persistCatalogRunRecoveryRecord: async () => {},
      } as unknown as RuntimeComposition;
      const dispatcher = createCatalogDispatcher({
        agentCatalog: { find: () => worker },
        runtime,
        runtimeServices: createManualRuntimeServices(),
        getShutdownPromise: () => undefined,
        catalogRuns: new Set(),
        runAttribution: new Map(),
        detachBestEffortPromise: () => {},
        createBureauError: (message, code) => Object.assign(new Error(message), { code }),
        validateAgentRunInput: () => {},
        onDurableRunAborted: () => {},
      });
      return { dispatcher, engine, generates: () => generates, fenceTargets };
    }

    it('creates the run, which takes zero agent steps and ends', async () => {
      const { dispatcher, engine, generates, fenceTargets } = await overtakenStart();

      const started = dispatcher.startGoalAttemptRun(attempt);
      await started.durablyStarted;
      const result = await started.run.result();

      // The run exists, as a start no one can atomically withhold must be allowed to:
      expect(await engine.get(attempt.runId)).not.toBeNull();
      // and it took no step, and ended.
      expect(generates()).toBe(0);
      expect(result.steps).toHaveLength(0);
      expect(result.finishReason).toBe('tripwire');
      const ended = await engine.get(attempt.runId);
      expect(ended?.status).toBe('completed');
      // The fence was built for this attempt's own identity.
      expect(fenceTargets).toEqual([{ goalRunId: 'g1', attemptIndex: 0, runId: attempt.runId }]);
    });
  });

  describe('overlapping executions of one attempt', () => {
    const PRICING = (rate: number) => ({
      customPricing: {
        m: { promptCostPerMillionTokens: rate, completionCostPerMillionTokens: rate },
      },
    });

    /** A worker whose resolver always declares the given estimator, and which records what it ran. */
    function priced(costEstimation: unknown, ran: string[]) {
      const base = createAgent({
        name: 'worker',
        generate: async ({ conversation }) => {
          ran.push(lastPromptOf(conversation));
          return {
            content: 'done',
            toolCalls: [],
            usage: { prompt: 1_000_000, completion: 1_000_000, total: 2_000_000 },
          };
        },
        stopWhen: stopWhen.noToolCalls(),
      });
      const resolve = (
        base as unknown as Record<
          symbol,
          (input: unknown, context: unknown) => Promise<Record<string, unknown>>
        >
      )[OPERATIVE_RESOLVE_RUN_OPTIONS];
      if (resolve === undefined) throw new Error('the worker has no run-option resolver');
      return Object.create(base, {
        [OPERATIVE_RESOLVE_RUN_OPTIONS]: {
          value: (input: unknown, context: unknown) =>
            resolve.call(base, input, context).then((options) => ({ ...options, costEstimation })),
        },
      });
    }

    async function world(agent: unknown, seeded?: Record<string, unknown>) {
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
      const records = new Map<string, Record<string, unknown>>();
      if (seeded !== undefined) records.set(attempt.runId, seeded);
      const writes: unknown[] = [];
      const runtime = {
        durable: { engine, checkpointStore },
        createBureauInvariantHooks: () => undefined,
        composeRunHooks: composeTestRunHooks,
        mediaOptionsFor: () => ({}),
        withChatPermission: (toolbox: unknown) => toolbox,
        holdToModelPolicy: (options: unknown) => options,
        claimCatalogRunRecoveryRecord: async (runId: string, record: Record<string, unknown>) => {
          if (records.has(runId)) return false;
          records.set(runId, { schemaVersion: 1, ...record });
          return true;
        },
        loadCatalogRunRecoveryRecord: async (runId: string) => {
          const record = records.get(runId);
          return record === undefined ? { status: 'missing' } : { status: 'found', record };
        },
        persistCatalogRunRecoveryRecord: async (runId: string, record: Record<string, unknown>) => {
          writes.push(record);
          records.set(runId, { schemaVersion: 1, ...record });
        },
      } as unknown as RuntimeComposition;
      const runAttribution = new Map<string, RunAttribution>();
      const dispatcher = createCatalogDispatcher({
        agentCatalog: { find: () => agent as never },
        runtime,
        runtimeServices: createManualRuntimeServices(),
        getShutdownPromise: () => undefined,
        catalogRuns: new Set(),
        runAttribution,
        detachBestEffortPromise: () => {},
        createBureauError: (message, code) => Object.assign(new Error(message), { code }),
        validateAgentRunInput: () => {},
        onDurableRunAborted: () => {},
      });
      return { dispatcher, records, writes, engine, runAttribution };
    }

    const firstClaim = {
      schemaVersion: 1,
      agentName: 'worker',
      definitionRevision: 1,
      input: 'first input',
      goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
      costEstimation: { model: 'm', pricing: PRICING(1) },
    };

    it('starts a workflow from the winning claim, never from what it resolves itself', async () => {
      const ran: string[] = [];
      const { dispatcher, records, writes } = await world(
        priced({ model: 'm', pricing: PRICING(10) }, ran),
        firstClaim,
      );

      const started = dispatcher.startGoalAttemptRun({ ...attempt, input: 'second input' });
      await started.durablyStarted;
      const result = await started.run.result();

      // The claim is exactly what the first execution wrote.
      expect(writes).toEqual([]);
      expect(records.get(attempt.runId)).toEqual(firstClaim);
      // And the workflow ran its input at its rate, not the second execution's.
      expect(ran).toHaveLength(1);
      expect(ran[0]).toContain('first input');
      expect(ran[0]).not.toContain('second input');
      expect(result.costEstimate?.totalCost).toBeCloseTo(2, 5);
    });

    it('releases an execution’s share when its own durable start rejects, so the retry’s later failure deletes the entry', async () => {
      const { dispatcher, engine, runAttribution } = await world(
        priced({ model: 'm', pricing: PRICING(1) }, []),
      );
      let prepareCalls = 0;
      let openSecond: () => void = () => {};
      const secondMayFail = new Promise<void>((resolve) => {
        openSecond = resolve;
      });
      engine.prepare = async () => {
        prepareCalls += 1;
        if (prepareCalls === 2) await secondMayFail;
        throw new Error(`durable start ${prepareCalls} rejected`);
      };

      const first = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      const second = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });
      expect(await settle(first)).toEqual(
        expect.objectContaining({ message: 'durable start 1 rejected' }),
      );
      // The second execution still holds the entry.
      expect(runAttribution.has(attempt.runId)).toBe(true);

      openSecond();
      expect(await settle(second)).toEqual(
        expect.objectContaining({ message: 'durable start 2 rejected' }),
      );
      expect(runAttribution.has(attempt.runId)).toBe(false);
    });

    it('settles durablyStarted with the engine’s refusal and drops the attribution, leaving no rejection unhandled (COR-1418)', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const { dispatcher, engine, runAttribution } = await world(
          priced({ model: 'm', pricing: PRICING(1) }, []),
        );
        engine.prepare = async () => {
          throw new Error('the engine refused the workflow');
        };

        const started = dispatcher.startGoalAttemptRun({ ...attempt, principal: 'alice' });

        expect(await settle(started)).toEqual(
          expect.objectContaining({ message: 'the engine refused the workflow' }),
        );
        expect(runAttribution.has(attempt.runId)).toBe(false);
        const result = await started.run.result();
        expect(result.finishReason).toBe('error');
        // A rejection nothing handled is reported once the microtask queue drains and a timer turn
        // has passed, so the observation waits one turn on a real timer.
        await new Promise<void>((resolve) => realRuntime.timers.setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('adopts the claim of an execution whose workflow already exists', async () => {
      const ran: string[] = [];
      const { dispatcher, records, writes, engine } = await world(
        priced({ model: 'm', pricing: PRICING(1) }, ran),
      );
      const winner = dispatcher.startGoalAttemptRun({ ...attempt, input: 'first input' });
      await winner.durablyStarted;
      const claimed = structuredClone(records.get(attempt.runId));

      const loser = createCatalogDispatcher({
        agentCatalog: { find: () => priced({ model: 'm', pricing: PRICING(10) }, ran) as never },
        runtime: {
          durable: { engine, checkpointStore: {} },
          createBureauInvariantHooks: () => undefined,
          composeRunHooks: composeTestRunHooks,
          mediaOptionsFor: () => ({}),
          withChatPermission: (toolbox: unknown) => toolbox,
          holdToModelPolicy: (options: unknown) => options,
          claimCatalogRunRecoveryRecord: async () => false,
          loadCatalogRunRecoveryRecord: async () => ({ status: 'found', record: claimed }),
          persistCatalogRunRecoveryRecord: async (_id: string, record: unknown) => {
            writes.push(record);
          },
        } as unknown as RuntimeComposition,
        runtimeServices: createManualRuntimeServices(),
        getShutdownPromise: () => undefined,
        catalogRuns: new Set(),
        runAttribution: new Map(),
        detachBestEffortPromise: () => {},
        createBureauError: (message, code) => Object.assign(new Error(message), { code }),
        validateAgentRunInput: () => {},
        onDurableRunAborted: () => {},
      });
      const refusal = await settle(
        loser.startGoalAttemptRun({ ...attempt, input: 'second input' }),
      );

      // The workflow is the winner's, so the loser's start is refused by the
      // engine (the goal port adopts it), and the claim is left alone.
      expect(refusal).toEqual(expect.objectContaining({ code: 'WorkflowAlreadyExistsError' }));
      expect(writes).toEqual([]);
      expect(records.get(attempt.runId)).toEqual(claimed);
      await winner.run.result();
    });
  });

  describe('a resolver that declares an estimator that cannot be persisted', () => {
    const cyclic: Record<string, unknown> = { model: 'm' };
    cyclic['self'] = cyclic;
    const throwingToJson = {
      model: 'm',
      toJSON: () => {
        throw new Error('toJSON failed');
      },
    };
    const price = (value: number) => ({
      model: 'm',
      pricing: {
        customPricing: {
          m: { promptCostPerMillionTokens: value, completionCostPerMillionTokens: 1 },
        },
      },
    });

    it.each([
      ['a cycle', cyclic],
      ['a bigint', { model: 'm', pricing: { customPricing: { m: { x: 1n } } } }],
      ['a throwing toJSON', throwingToJson],
      ['extra fields', { model: 'm', extra: true }],
      ['a negative price', price(-1)],
      ['a non-finite price', price(Number.NaN)],
      ['an empty model', { model: '' }],
    ])('ends the attempt permanently for %s, writing no claim', async (_label, costEstimation) => {
      const base = createAgent({
        name: 'worker',
        generate: async () => ({ content: 'done', toolCalls: [] }),
        stopWhen: stopWhen.noToolCalls(),
      });
      const resolve = (
        base as unknown as Record<
          symbol,
          (input: unknown, context: unknown) => Promise<Record<string, unknown>>
        >
      )[OPERATIVE_RESOLVE_RUN_OPTIONS];
      if (resolve === undefined) throw new Error('the worker has no run-option resolver');
      const agent = Object.create(base, {
        [OPERATIVE_RESOLVE_RUN_OPTIONS]: {
          value: (input: unknown, context: unknown) =>
            resolve.call(base, input, context).then((options) => ({ ...options, costEstimation })),
        },
      });
      const claims: unknown[] = [];
      const runtime = {
        durable: { engine: {}, checkpointStore: {} },
        createBureauInvariantHooks: () => undefined,
        composeRunHooks: composeTestRunHooks,
        mediaOptionsFor: () => ({}),
        withChatPermission: (toolbox: unknown) => toolbox,
        holdToModelPolicy: (options: unknown) => options,
        claimCatalogRunRecoveryRecord: async (_id: string, record: unknown) => {
          claims.push(record);
          return true;
        },
        persistCatalogRunRecoveryRecord: async () => {},
      } as unknown as RuntimeComposition;
      const dispatcher = createCatalogDispatcher({
        agentCatalog: { find: () => agent as never },
        runtime,
        runtimeServices: createManualRuntimeServices(),
        getShutdownPromise: () => undefined,
        catalogRuns: new Set(),
        runAttribution: new Map(),
        detachBestEffortPromise: () => {},
        createBureauError: (message, code) => Object.assign(new Error(message), { code }),
        validateAgentRunInput: () => {},
        onDurableRunAborted: () => {},
      });

      const error = await dispatcher.startGoalAttemptRun(attempt).durablyStarted.then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(GoalAttemptInvalidCostEstimationError);
      expect((error as GoalAttemptInvalidCostEstimationError).reason).toBe(
        'invalid-cost-estimation',
      );
      expect(claims).toEqual([]);
    });
  });
});

/**
 * COR-1630 — the dispatcher tells Bureau when a catalog run's handle has settled, so Bureau can let
 * go of the claims the run's rows hold. It is the one place every run that is not a goal attempt
 * passes: `bureau.run()`, a child, and a workflow step, durable or not. A goal attempt is left to
 * the goal forwarder, which hands its rows to the goal's session first. Whether the settled handle
 * is an end (it is not, for a run cut short by disposing the engine) is Bureau's to decide.
 */
describe('createCatalogDispatcher — telling Bureau a run settled (COR-1630)', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });

  const processLocal = {
    createBureauInvariantHooks: () => undefined,
    composeRunHooks: composeTestRunHooks,
    mediaOptionsFor: () => ({}),
    withChatPermission: (toolbox: unknown) => toolbox,
    holdToModelPolicy: (options: unknown) => options,
  } as unknown as RuntimeComposition;

  async function durableComposition(): Promise<RuntimeComposition> {
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
      composeRunHooks: composeTestRunHooks,
      mediaOptionsFor: () => ({}),
      withChatPermission: (toolbox: unknown) => toolbox,
      holdToModelPolicy: (options: unknown) => options,
      claimCatalogRunRecoveryRecord: async () => true,
      persistCatalogRunRecoveryRecord: async () => {},
    } as unknown as RuntimeComposition;
  }

  function observed(runtime: RuntimeComposition) {
    const ended: CatalogRunEnded[] = [];
    const dispatcher = createDispatcher(false, {
      runtime,
      onCatalogRunEnded: (end) => void ended.push(end),
    });
    return { dispatcher, ended };
  }

  it('reports a process-local child run under the id its topology recorded', async () => {
    const { dispatcher, ended } = observed(processLocal);

    await dispatcher.startChildRun({ ...start, agentName: 'worker', principal: 'alice' }).result();

    expect(ended).toEqual([expect.objectContaining({ runId: 'child-1', principal: 'alice' })]);
  });

  it('holds a process-local child’s toolbox to the mode of its chat, under the child’s own id (COR-1955)', async () => {
    const governed: string[] = [];
    const runtime = {
      ...processLocal,
      withChatPermission: (toolbox: unknown, runId: string) => {
        governed.push(runId);
        return toolbox;
      },
    } as unknown as RuntimeComposition;

    await observed(runtime)
      .dispatcher.startChildRun({ ...start, agentName: 'worker', principal: 'alice' })
      .result();

    expect(governed).toEqual(['child-1']);
  });

  it('reports a durable workflow step', async () => {
    const { dispatcher, ended } = observed(await durableComposition());

    await dispatcher
      .startWorkflowStepRun({
        agentName: 'worker',
        input: 'work',
        runId: 'step-run-1',
        workflowStep: { workflowId: 'workflow-1', step: 0 },
        principal: 'alice',
      })
      .result();

    expect(ended).toEqual([expect.objectContaining({ runId: 'step-run-1', principal: 'alice' })]);
  });

  it('holds a durable run’s toolbox to the mode of its chat, under the run’s own id (COR-1947)', async () => {
    const governed: string[] = [];
    const runtime = {
      ...(await durableComposition()),
      withChatPermission: (toolbox: unknown, runId: string) => {
        governed.push(runId);
        return toolbox;
      },
    } as unknown as RuntimeComposition;

    await observed(runtime)
      .dispatcher.startWorkflowStepRun({
        agentName: 'worker',
        input: 'work',
        runId: 'step-run-2',
        workflowStep: { workflowId: 'workflow-1', step: 0 },
        principal: 'alice',
      })
      .result();

    expect(governed).toEqual(['step-run-2']);
  });

  it('does not report a goal attempt: the goal forwarder releases it, after the goal session holds its rows', async () => {
    const { dispatcher, ended } = observed(await durableComposition());

    const started = dispatcher.startGoalAttemptRun({
      agentName: 'worker',
      input: 'work',
      runId: 'goal-g1-a0',
      goalRunId: 'g1',
      attemptIndex: 0,
    });
    await started.durablyStarted;
    await started.run.result();

    expect(ended).toEqual([]);
  });
});
