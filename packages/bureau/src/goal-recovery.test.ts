/**
 * COR-851 — what `recoverGoal` decides, driven with a scripted engine so that
 * each state the controller and the attempt's run can be found in is set
 * directly. `goals-recovery.test.ts` shows the same recovery across real
 * process restarts.
 */
import type { Validator } from '@lostgradient/operative';
import { MemoryStorage, textValueStore, WorkflowTeardownPendingError } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { commitCancellation, type GoalControlDependencies } from './goal-controller';
import { recoverEveryGoal, recoverGoal } from './goal-recovery';
import { createGoalState } from './goal-state';
import { createGoalStore } from './goal-store';
import type { GoalEngine } from './goal-types';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import {
  dependencies,
  NOW,
  runningGoal,
  scriptedEngine,
} from './testing/goal-control-fixtures.test-support';

function validator(determinism: 'deterministic' | 'stochastic'): Validator {
  return {
    identity: { name: 'check', version: '1' },
    determinism,
    validate: () => Promise.resolve({ kind: 'pass', evidence: [] }),
  };
}

/** The scripted engine, with `start` and `get` replaced so a test sees and shapes them. */
function engineWith(
  base: GoalEngine,
  overrides: { get?: GoalEngine['get']; start?: (...args: unknown[]) => Promise<unknown> },
): GoalEngine {
  return { ...base, ...overrides } as unknown as GoalEngine;
}

describe('completing a cancellation', () => {
  async function recoverCanceled(
    attemptRun: string,
    cancelRun: GoalControlDependencies['cancelRun'],
  ) {
    const store = await runningGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'cancelled', 'goal-g1-a0': attemptRun },
    });
    const { control, diagnostics } = dependencies(store, engine, { cancelRun });
    const entry = await recoverGoal(control, 'g1');
    return { entry, diagnostics, store };
  }

  it('is pending, not canceled, while the attempt it could not stop is still running', async () => {
    const { entry, diagnostics, store } = await recoverCanceled('running', () =>
      Promise.resolve({ status: 'failed', error: new Error('engine busy') }),
    );

    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'cancellation-pending' });
    expect(entry.detail).toContain('attempt-run');
    expect(diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain('engine busy');
    // The record was committed regardless: the marker is authoritative.
    const committed = await store.get('g1');
    expect(committed?.status).toBe('canceled');
  });

  it('is canceled once the read finds the attempt stopped', async () => {
    const { entry } = await recoverCanceled('cancelled', () =>
      Promise.resolve({ status: 'requested' }),
    );

    expect(entry).toEqual({ goalRunId: 'g1', outcome: 'canceled' });
  });
});

describe('a suspended controller', () => {
  it('is resumed when no cancellation was asked for', async () => {
    const store = await runningGoal();
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'suspended', 'goal-g1-a0': 'running' },
    });
    const { control } = dependencies(store, engine);

    expect(await recoverGoal(control, 'g1')).toMatchObject({ outcome: 'running' });

    expect(calls).toContain('resume:goal:g1');
    expect(calls).not.toContain('cancel:goal:g1');
  });

  it('is cancelled, not resumed, when the process died after marking a cancellation and before acting on it', async () => {
    const store = await runningGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const workflows: Record<string, string> = {
      'goal:g1': 'suspended',
      'goal-g1-a0': 'running',
    };
    const { engine, calls } = scriptedEngine({
      workflows,
      // The cancel ends the workflow; the run is stopped through `cancelRun`.
      onCancel: () => {
        workflows['goal:g1'] = 'cancelled';
        return Promise.resolve();
      },
    });
    const stopped: string[] = [];
    const { control } = dependencies(store, engine, {
      cancelRun: (runId) => {
        stopped.push(runId);
        workflows[runId] = 'cancelled';
        return Promise.resolve({ status: 'requested' });
      },
    });

    const entry = await recoverGoal(control, 'g1');

    // A resumed controller would re-park on an attempt signal the marker never sends.
    expect(calls).not.toContain('resume:goal:g1');
    expect(calls).toContain('cancel:goal:g1');
    expect(stopped).toContain('goal-g1-a0');
    expect(entry).toEqual({ goalRunId: 'g1', outcome: 'canceled' });
    expect((await store.get('g1'))?.status).toBe('canceled');
  });

  it('stays pending on the controller when a marked cancellation cannot end it', async () => {
    const store = await runningGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'suspended', 'goal-g1-a0': 'cancelled' },
      cancelThrows: true,
    });
    const { control } = dependencies(store, engine);

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toMatchObject({ outcome: 'cancellation-pending' });
    expect(entry.detail).toContain('controller');
  });
});

describe('a goal whose cancellation committed but whose cleanup is still owed', () => {
  async function committedCanceled() {
    const store = await runningGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const marked = (await store.get('g1'))!;
    await commitCancellation(store, marked, Date.parse(NOW));
    const committed = await store.get('g1');
    expect(committed?.status).toBe('canceled');
    return store;
  }

  it('is driven to settlement by recover(), not reported already terminal', async () => {
    const store = await committedCanceled();
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'running', 'goal-g1-a0': 'running' },
    });
    const { control, stopped } = dependencies(store, engine);

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'cancellation-pending' });
    expect(entry.detail).toContain('controller');
    expect(calls).toContain('cancel:goal:g1');
    expect(stopped).toContain('goal-g1-a0');
  });

  it('is already terminal once the controller, finalizer, and attempt have all settled', async () => {
    const store = await committedCanceled();
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' },
      finalizer: { status: 'succeeded' },
    });
    const { control } = dependencies(store, engine);

    expect(await recoverGoal(control, 'g1')).toEqual({
      goalRunId: 'g1',
      outcome: 'already-terminal',
    });
    expect(calls).toEqual([]);
  });

  it('leaves a settled canceled goal out of the sweep report, like any other ended goal', async () => {
    const store = await committedCanceled();
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'cancelled', 'goal-g1-a0': 'cancelled' },
      finalizer: { status: 'succeeded' },
    });
    const { control } = dependencies(store, engine);

    expect(await recoverEveryGoal(control)).toEqual({ goals: [], failures: [] });
  });

  it('is included in the boot sweep, which finishes the cleanup', async () => {
    const store = await committedCanceled();
    const { engine, calls } = scriptedEngine({
      workflows: { 'goal:g1': 'running', 'goal-g1-a0': 'running' },
    });
    const { control } = dependencies(store, engine);

    const report = await recoverEveryGoal(control);

    expect(report.goals.map((entry) => [entry.goalRunId, entry.outcome])).toEqual([
      ['g1', 'cancellation-pending'],
    ]);
    expect(calls).toContain('cancel:goal:g1');
  });
});

describe('a goal that was recorded but never started', () => {
  async function pendingStore(validatorDeterminism: 'deterministic' | 'stochastic') {
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
    const catalog = createGoalValidatorCatalog([validator(validatorDeterminism)]);
    return { store, catalog };
  }

  it('is ended unsupported-validation by recovery, and no controller is started for it', async () => {
    const { store, catalog } = await pendingStore('stochastic');
    const started: unknown[][] = [];
    const { engine } = scriptedEngine({ workflows: {} });
    const { control } = dependencies(
      store,
      engineWith(engine, {
        start: (...args) => {
          started.push(args);
          return Promise.resolve();
        },
      }),
      { catalog },
    );

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toEqual({ goalRunId: 'g1', outcome: 'unsupported-validation' });
    expect(await store.get('g1')).toMatchObject({
      status: 'failed',
      terminalReason: 'unsupported-validation',
      attempts: [],
    });
    expect(started).toEqual([]);
  });

  it('is started when its validator does supply the evidence it requires', async () => {
    const { store, catalog } = await pendingStore('deterministic');
    const started: unknown[][] = [];
    const { engine } = scriptedEngine({ workflows: {} });
    const { control } = dependencies(
      store,
      engineWith(engine, {
        start: (...args) => {
          started.push(args);
          return Promise.resolve();
        },
      }),
      { catalog },
    );

    expect(await recoverGoal(control, 'g1')).toMatchObject({ outcome: 'started' });
    expect(started).toHaveLength(1);
    const untouched = await store.get('g1');
    expect(untouched?.status).toBe('pending');
  });
});

describe('restarting a controller that ended abnormally', () => {
  it('counts one restart when two recoveries saw the same ended controller, and starts one controller', async () => {
    const store = await runningGoal();
    const started: unknown[][] = [];
    const { engine } = scriptedEngine({ workflows: { 'goal:g1': 'failed' } });
    const { control } = dependencies(
      store,
      engineWith(engine, {
        start: (...args) => {
          started.push(args);
          return Promise.resolve();
        },
      }),
    );

    const [first, second] = await Promise.all([
      recoverGoal(control, 'g1'),
      recoverGoal(control, 'g1'),
    ]);

    expect([first.outcome, second.outcome].toSorted()).toEqual(['restarted', 'running']);
    const counted = await store.get('g1');
    expect(counted?.controllerRestarts).toBe(1);
    expect(started).toHaveLength(1);
  });

  it('does not spend a restart while the ended controller still owes its finalizer', async () => {
    const store = await runningGoal();
    const started: unknown[][] = [];
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'failed' },
      finalizer: { status: 'pending', attempts: 0 },
    });
    const { control } = dependencies(
      store,
      engineWith(engine, {
        start: (...args) => {
          started.push(args);
          return Promise.resolve();
        },
      }),
    );

    const entry = await recoverGoal(control, 'g1');

    expect(entry).toMatchObject({ goalRunId: 'g1', outcome: 'running' });
    expect(entry.detail).toContain('finalizer');
    expect(started).toEqual([]);
    const unspent = await store.get('g1');
    expect(unspent?.controllerRestarts).toBe(0);
  });

  it('answers running, never throws, when Weft refuses the restart for a teardown that began after the check', async () => {
    const store = await runningGoal();
    const { engine } = scriptedEngine({ workflows: { 'goal:g1': 'failed' } });
    const { control } = dependencies(
      store,
      engineWith(engine, {
        start: () => Promise.reject(new WorkflowTeardownPendingError('goal:g1')),
      }),
    );

    expect(await recoverGoal(control, 'g1')).toMatchObject({ goalRunId: 'g1', outcome: 'running' });
  });

  it('restarts once the finalizer has settled', async () => {
    const store = await runningGoal();
    const { engine } = scriptedEngine({
      workflows: { 'goal:g1': 'failed' },
      finalizer: { status: 'succeeded' },
    });
    const { control } = dependencies(store, engineWith(engine, { start: () => Promise.resolve() }));

    expect(await recoverGoal(control, 'g1')).toMatchObject({ outcome: 'restarted' });
    const spent = await store.get('g1');
    expect(spent?.controllerRestarts).toBe(1);
  });
});

describe('a controller that completed while its goal was still not terminal', () => {
  it('is not restarted for a goal whose validator cannot supply the evidence it requires', async () => {
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
    const started: unknown[][] = [];
    const { engine } = scriptedEngine({ workflows: { 'goal:g1': 'completed' } });
    const { control } = dependencies(
      store,
      engineWith(engine, {
        start: (...args) => {
          started.push(args);
          return Promise.resolve();
        },
      }),
      { catalog: createGoalValidatorCatalog([validator('stochastic')]) },
    );

    expect(await recoverGoal(control, 'g1')).toEqual({
      goalRunId: 'g1',
      outcome: 'unsupported-validation',
    });
    expect(started).toEqual([]);
    expect(await store.get('g1')).toMatchObject({
      status: 'failed',
      terminalReason: 'unsupported-validation',
    });
  });
});

describe('recoverEveryGoal', () => {
  it('sweeps only the goals the caller is allowed to see', async () => {
    const store = await runningGoal();
    const { engine } = scriptedEngine({ workflows: { 'goal:g1': 'running' } });
    const { control } = dependencies(store, engine);

    const hidden = await recoverEveryGoal(control, () => false);
    const visible = await recoverEveryGoal(control, () => true);

    expect(hidden).toEqual({ goals: [], failures: [] });
    expect(visible.goals.map((entry) => entry.goalRunId)).toEqual(['g1']);
  });
});
