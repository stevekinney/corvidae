/**
 * COR-851 — recovery and the controller guard decide on a record read before
 * several awaits. A cancellation (or an ending) that lands in that gap must be
 * honored by the start it would otherwise still make, and a result the guard
 * cannot read or the record cannot take must not read as success.
 */
import { GOAL_WORKFLOW_TYPE, type Validator } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { Engine, KEYS, WorkflowClaimUnavailableError, workflow } from '@lostgradient/weft';
import { describe, expect, it, spyOn } from 'bun:test';

import { commitCancellation, ensureController } from './goal-controller';
import { recoverGoal } from './goal-recovery';
import { createGoalState, goalWorkflowId } from './goal-state';
import { createGoalStore, type GoalStore } from './goal-store';
import type { GoalEngine } from './goal-types';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import {
  dependencies,
  NOW,
  runningGoal,
  scriptedEngine,
} from './testing/goal-control-fixtures.test-support';

const MARKER = { requestedAt: NOW, reason: 'operator' };

function startsOf(calls: readonly string[]): string[] {
  return calls.filter((call) => call.startsWith('start:'));
}

/** The scripted engine with `get` and `getFinalizerStatus` hooks that run inside recovery's awaits. */
function engineWithHooks(
  base: GoalEngine,
  hooks: { get?: () => Promise<void>; getFinalizerStatus?: () => Promise<void> },
  calls: string[],
): GoalEngine {
  return {
    ...base,
    get: async (id: string) => {
      await hooks.get?.();
      return base.get(id);
    },
    getFinalizerStatus: async (id: string) => {
      await hooks.getFinalizerStatus?.();
      return base.getFinalizerStatus(id);
    },
    start: (_type: string, _input: unknown, options?: { id?: string }) => {
      calls.push(`start:${options?.id ?? ''}`);
      return Promise.resolve();
    },
  } as unknown as GoalEngine;
}

describe('recovery when a cancellation lands between its read and its start', () => {
  it('starts no controller for a goal whose workflow was never found, and completes the cancellation', async () => {
    const store = await runningGoal();
    const { engine, calls } = scriptedEngine({ workflows: { 'goal-g1-a0': 'cancelled' } });
    const hooked = engineWithHooks(
      engine,
      {
        get: async () => {
          await store.requestCancellation('g1', MARKER, NOW);
        },
      },
      calls,
    );
    const { control } = dependencies(store, hooked);

    const entry = await recoverGoal(control, 'g1');

    expect(startsOf(calls)).toEqual([]);
    expect(entry.outcome).toBe('canceled');
    const committed = await store.get('g1');
    expect(committed?.status).toBe('canceled');
  });

  it('starts no replacement controller and spends no restart for a goal canceled while its finalizer was read', async () => {
    const store = await runningGoal();
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'failed', 'goal-g1-a0': 'cancelled' },
    });
    const hooked = engineWithHooks(
      engine,
      {
        getFinalizerStatus: async () => {
          await store.requestCancellation('g1', MARKER, NOW);
        },
      },
      calls,
    );
    const { control } = dependencies(store, hooked);

    const entry = await recoverGoal(control, 'g1');

    expect(startsOf(calls)).toEqual([]);
    expect(entry.outcome).toBe('canceled');
    const unspent = await store.get('g1');
    expect(unspent?.controllerRestarts).toBe(0);
  });
});

describe('recovery when a cancellation lands between counting a restart and starting it', () => {
  it('starts no replacement controller and completes the cancellation', async () => {
    const store = await runningGoal();
    const racing: GoalStore = {
      ...store,
      recordControllerRestart: async (goalRunId, now, expectedCount) => {
        const counted = await store.recordControllerRestart(goalRunId, now, expectedCount);
        await store.requestCancellation(goalRunId, MARKER, NOW);
        return counted;
      },
    };
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'failed', 'goal-g1-a0': 'cancelled' },
    });
    const { control } = dependencies(racing, engine);

    const entry = await recoverGoal(control, 'g1');

    expect(startsOf(calls)).toEqual([]);
    expect(entry.outcome).toBe('canceled');
  });

  it('completes the cancellation instead of counting a restart when the marker landed before the count', async () => {
    const store = await runningGoal();
    const racing: GoalStore = {
      ...store,
      recordControllerRestart: async (goalRunId, now, expectedCount) => {
        await store.requestCancellation(goalRunId, MARKER, NOW);
        return store.recordControllerRestart(goalRunId, now, expectedCount);
      },
    };
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'failed', 'goal-g1-a0': 'cancelled' },
    });
    const { control } = dependencies(racing, engine);

    const entry = await recoverGoal(control, 'g1');

    expect(startsOf(calls)).toEqual([]);
    expect(entry.outcome).toBe('canceled');
    const unspent = await store.get('g1');
    expect(unspent?.controllerRestarts).toBe(0);
  });
});

describe('completing a cancellation another caller committed first', () => {
  it('settles the canceled goal instead of answering already-terminal without stopping anything', async () => {
    const store = await runningGoal();
    const racing: GoalStore = {
      ...store,
      requestCancellation: async (goalRunId, marker, now) => {
        // The goal ends canceled, with no marker, before this recovery's marker lands,
        // so the store refuses the marker of a goal that is already over.
        await commitCancellation(store, (await store.get(goalRunId))!, Date.parse(NOW));
        return store.requestCancellation(goalRunId, marker, now);
      },
    };
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' },
    });
    const { control, stopped } = dependencies(racing, engine);

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toEqual({ goalRunId: 'g1', outcome: 'canceled' });
    expect(stopped).toContain('goal-g1-a0');
  });
});

describe('the cleanup a closed goal owes', () => {
  it('is reported pending when recording it done did not land', async () => {
    const store = await runningGoal();
    await store.requestCancellation('g1', MARKER, NOW);
    await commitCancellation(store, (await store.get('g1'))!, Date.parse(NOW));
    await store.close('g1', NOW);
    const lossy: GoalStore = {
      ...store,
      markCleanedUp: async (goalRunId) => ({
        status: 'stale',
        record: (await store.get(goalRunId))!,
      }),
    };
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' },
    });
    const { control } = dependencies(lossy, engine);

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'cleanup-pending' });
    const unmarked = await store.get('g1');
    expect(unmarked?.cleanedUpAt).toBeUndefined();
  });
});

describe('ensureController after another engine takes the start claim', () => {
  it('finds the live controller that won the atomic start without reporting a lost controller', async () => {
    await using storage = new MemoryStorage();
    const controller = workflow({ name: GOAL_WORKFLOW_TYPE }).execute(async function* (
      context,
      _input: { goalRunId: string },
    ) {
      yield* context.waitForSignal('finish');
      return 'finished';
    });
    const options = {
      storage,
      workflows: { [GOAL_WORKFLOW_TYPE]: controller },
      ownership: 'workflow-lease',
      recover: false,
      backgroundTasks: 'manual',
    } as const;
    await using losingEngine = await Engine.create(options);
    await using winningEngine = await Engine.create(options);
    const store = await runningGoal();
    const stale = (await store.get('g1'))!;
    const { control, diagnostics } = dependencies(store, losingEngine);
    const controllerId = goalWorkflowId(stale.goalRunId);
    const holderKey = KEYS.workflowOwnerHolder(controllerId);

    const atCommit = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let heldFirstCommit = false;
    let firstCommitResult: boolean | undefined;
    const conditionalBatch = storage.conditionalBatch.bind(storage);
    const batch = spyOn(storage, 'conditionalBatch').mockImplementation(
      async (conditions, operations) => {
        if (!heldFirstCommit && conditions.some(({ key }) => key === holderKey)) {
          heldFirstCommit = true;
          atCommit.resolve();
          await release.promise;
          firstCommitResult = await conditionalBatch(conditions, operations);
          return firstCommitResult;
        }
        return conditionalBatch(conditions, operations);
      },
    );

    const ensuring = ensureController(control, stale);
    try {
      expect(
        await Promise.race([
          atCommit.promise.then(() => 'committing'),
          ensuring.then(() => 'finished before committing'),
        ]),
      ).toBe('committing');
      const winningRun = await winningEngine.start(
        GOAL_WORKFLOW_TYPE,
        { goalRunId: stale.goalRunId },
        { id: controllerId },
      );
      await waitUntil(async () => (await winningEngine.get(controllerId))?.status === 'running', {
        message: 'the winning controller is running and waiting for its signal',
      });
      release.resolve();
      const result = await ensuring;
      expect(firstCommitResult).toBe(false);
      expect(result.controller).toEqual({ status: 'started' });
      expect(diagnostics).toEqual([]);
      await winningRun.signal('finish');
      expect(await winningRun.result()).toBe('finished');
    } finally {
      release.resolve();
      await ensuring;
      batch.mockRestore();
    }
  });

  it.each(['missing', 'terminal', 'unrelated type', 'different goal', 'unreadable'] as const)(
    'still reports a lost claim if the supposed winner is %s',
    async (scenario) => {
      const store = await runningGoal();
      const stale = (await store.get('g1'))!;
      const controllerId = goalWorkflowId(stale.goalRunId);
      const { engine } = scriptedEngine({
        workflows:
          scenario === 'missing'
            ? {}
            : { [controllerId]: scenario === 'terminal' ? 'completed' : 'running' },
      });
      const claimError = new WorkflowClaimUnavailableError(controllerId, 'other');
      const { control, diagnostics } = dependencies(store, {
        ...engine,
        start: () => Promise.reject(claimError),
        get: async (id) => {
          if (scenario === 'unreadable') throw new Error('controller lookup failed');
          const existing = await engine.get(id);
          return existing === null
            ? null
            : {
                ...existing,
                type: scenario === 'unrelated type' ? 'unrelated' : GOAL_WORKFLOW_TYPE,
                input: {
                  goalRunId: scenario === 'different goal' ? 'another-goal' : stale.goalRunId,
                },
              };
        },
      });

      const result = await ensureController(control, stale);

      expect(result.controller).toEqual({
        status: 'start-failed',
        reason:
          claimError.message +
          (scenario === 'unreadable'
            ? ' Could not confirm the controller: controller lookup failed'
            : ''),
      });
      expect(diagnostics).toMatchObject([{ cause: claimError }]);
    },
  );
});

describe('ensureController when its guard cannot be trusted', () => {
  it('starts no controller for a goal whose record can no longer be read', async () => {
    const store = await runningGoal();
    const stale = (await store.get('g1'))!;
    const unreadable: GoalStore = { ...store, get: () => Promise.resolve(undefined) };
    const { engine, calls } = scriptedEngine({ workflows: {} });
    const { control } = dependencies(unreadable, engine);

    const ensured = await ensureController(control, stale);

    expect(ensured.controller).toMatchObject({ status: 'start-failed' });
    expect(startsOf(calls)).toEqual([]);
  });

  it('starts no controller when a cancellation made the determinism failure it tried to record a rejection', async () => {
    const store = createGoalStore(textValueStore(new MemoryStorage()));
    await store.create(
      createGoalState({
        goalRunId: 'g1',
        identity: { name: 'goal', version: '1' },
        objective: { agentName: 'worker', prompt: 'work' },
        validator: { name: 'check', version: '1' },
        requireDeterministicValidation: true,
        conversationPolicy: { kind: 'continue' },
        bounds: { maximumAttempts: 2, maximumTotalSteps: 10 },
        now: NOW,
      }),
    );
    const stale = (await store.get('g1'))!;
    const racing: GoalStore = {
      ...store,
      applyTransition: async (request) => {
        await store.requestCancellation('g1', MARKER, NOW);
        return store.applyTransition(request);
      },
    };
    const stochastic: Validator = {
      identity: { name: 'check', version: '1' },
      determinism: 'stochastic',
      validate: () => Promise.resolve({ kind: 'pass', evidence: [] }),
    };
    const { engine, calls } = scriptedEngine({ workflows: {} });
    const { control } = dependencies(racing, engine, {
      catalog: createGoalValidatorCatalog([stochastic]),
    });

    const ensured = await ensureController(control, stale);

    expect(ensured.controller).toEqual({ status: 'not-needed' });
    expect(startsOf(calls)).toEqual([]);
  });
});
