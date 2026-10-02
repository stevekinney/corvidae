/**
 * COR-851 — what `recoverGoal` decides, driven with a scripted engine so that
 * each state the controller and the attempt's run can be found in is set
 * directly. `goals-recovery.test.ts` shows the same recovery across real
 * process restarts.
 */
import type { Validator } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { GoalControlDependencies } from './goal-controller';
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
