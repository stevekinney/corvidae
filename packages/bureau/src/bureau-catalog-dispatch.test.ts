/**
 * COR-772 — the catalog dispatcher's child-start guards. The child path is
 * otherwise exercised end to end through `bureau.children` in
 * `bureau-children.test.ts`; these are the refusals the topology never
 * reaches in normal operation, because it plans the child first and refuses
 * an identifier another run already holds before it starts anything.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  AgentContractError,
  createAgent,
  createCheckpointStore,
  createRunEngine,
  createRunWorkflow,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  createCatalogDispatcher,
  GoalAttemptNotDurableCapableError,
} from './bureau-catalog-dispatch';
import type { RuntimeComposition } from './runtime-composition';
import type { RunAttribution } from './serialization';

function createDispatcher(
  shuttingDown: boolean,
  options: {
    readonly runtime?: RuntimeComposition;
    readonly runAttribution?: Map<string, RunAttribution>;
  } = {},
) {
  const worker = createAgent({
    name: 'worker',
    generate: async () => ({ content: 'done', toolCalls: [] }),
    stopWhen: stopWhen.noToolCalls(),
  });
  return createCatalogDispatcher({
    agentCatalog: { find: (name: string) => (name === 'worker' ? worker : undefined) },
    // The first two refusals never reach the runtime composition.
    runtime: options.runtime ?? ({} as RuntimeComposition),
    runtimeServices: createManualRuntimeServices(),
    getShutdownPromise: () => (shuttingDown ? Promise.resolve() : undefined),
    catalogRuns: new Set(),
    runAttribution: options.runAttribution ?? new Map(),
    detachBestEffortPromise: () => {},
    createBureauError: (message, code) => Object.assign(new Error(message), { code }),
    validateAgentRunInput: () => {},
    validateBureauRunOptions: () => {},
    onDurableRunAborted: () => {},
  });
}

/** Just enough of a durable composition to reach the recovery-record write. */
function durableRuntime(claimed: boolean): RuntimeComposition {
  return {
    durable: { engine: {}, checkpointStore: {} },
    createBureauInvariantHooks: () => undefined,
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

  it('refuses to start a child for an agent the catalog does not have', () => {
    const dispatcher = createDispatcher(false);

    expect(dispatcher.planChildRun('nobody')).toBeUndefined();
    expect(() => dispatcher.startChildRun({ ...start, agentName: 'nobody' })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});

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
      validateBureauRunOptions: () => {},
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

  describe('a claim already holding the attempt id', () => {
    const conflicting = (record: Record<string, unknown> | undefined) => {
      const persisted: unknown[] = [];
      const runtime = {
        durable: { engine: {}, checkpointStore: {} },
        createBureauInvariantHooks: () => undefined,
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
    const settle = (started: { durablyStarted: Promise<void> }) =>
      started.durablyStarted.then(
        () => undefined,
        (error: unknown) => error,
      );

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

    it('completes its own claim, rewriting it with the marker', async () => {
      const { runtime, persisted } = conflicting({
        agentName: 'worker',
        goalAttempt: { goalRunId: 'g1', attemptIndex: 0 },
      });

      await settle(createDispatcher(false, { runtime }).startGoalAttemptRun(attempt));

      expect(persisted).toEqual([
        expect.objectContaining({ goalAttempt: { goalRunId: 'g1', attemptIndex: 0 } }),
      ]);
    });
  });
});
