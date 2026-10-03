/**
 * COR-851 — a scripted engine and the control-plane dependencies around it, for
 * the tests that drive `cancelGoal` and `recoverGoal` directly. Each thing a
 * read-back waits for can be left unfinished in turn.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/weft';

import type { GoalControlDependencies } from '../goal-controller';
import { createGoalState, goalAttemptId, goalAttemptRunId, goalTransitionId } from '../goal-state';
import { createGoalStore, type GoalStore } from '../goal-store';
import type { GoalEngine } from '../goal-types';
import { createGoalValidatorCatalog } from '../goal-validator-catalog';
import type { BureauDiagnostic } from '../types';

export const NOW = '2026-10-02T12:00:00.000Z';

export async function runningGoal(): Promise<GoalStore> {
  const store = createGoalStore(textValueStore(new MemoryStorage()));
  await store.create(
    createGoalState({
      goalRunId: 'g1',
      identity: { name: 'goal', version: '1' },
      objective: { agentName: 'worker', prompt: 'work' },
      validator: { name: 'check', version: '1' },
      conversationPolicy: { kind: 'continue' },
      bounds: { maximumAttempts: 2, maximumTotalSteps: 10 },
      now: NOW,
    }),
  );
  const attemptId = goalAttemptId('g1', 0);
  const runId = goalAttemptRunId('g1', 0);
  await store.applyTransition({
    goalRunId: 'g1',
    seq: 1,
    transitionId: goalTransitionId('g1', 1),
    to: 'running',
    at: NOW,
    cause: 'attempt 0 started',
    attempt: {
      attemptId,
      attemptIndex: 0,
      runId,
      sessionId: runId,
      startedAt: NOW,
      usage: { steps: 0, tokens: 0 },
      status: 'running',
    },
    usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
    active: { kind: 'attempt', attemptId, runId, startedAt: NOW },
  });
  return store;
}

export interface Script {
  /** Statuses `engine.get` answers, by workflow id. A missing key is `null`. */
  readonly workflows: Record<string, string>;
  readonly finalizer?: { status: string; attempts?: number; error?: string } | null;
  /** Runs inside `engine.cancel`, before it settles. */
  readonly onCancel?: () => Promise<void>;
  readonly cancelThrows?: boolean;
}

export function scriptedEngine(script: Script) {
  const calls: string[] = [];
  const engine = {
    get: (id: string) => {
      const status = script.workflows[id];
      return Promise.resolve(status === undefined ? null : { id, status });
    },
    signal: (id: string, name: string) => {
      calls.push(`signal:${id}:${name}`);
      return Promise.resolve();
    },
    cancel: async (id: string) => {
      calls.push(`cancel:${id}`);
      await script.onCancel?.();
      if (script.cancelThrows === true) throw new Error('engine unavailable');
    },
    resume: (id: string) => {
      calls.push(`resume:${id}`);
      return Promise.resolve();
    },
    getFinalizerStatus: () => Promise.resolve(script.finalizer ?? null),
  } as unknown as GoalEngine;
  return { engine, calls };
}

export function dependencies(
  store: GoalStore,
  engine: GoalEngine,
  extra: Partial<GoalControlDependencies> = {},
) {
  const diagnostics: BureauDiagnostic[] = [];
  const stopped: string[] = [];
  const control: GoalControlDependencies = {
    store,
    catalog: createGoalValidatorCatalog([]),
    clock: { now: () => Date.parse(NOW), nowISO: () => NOW },
    diagnose: (diagnostic) => diagnostics.push(diagnostic),
    getEngine: () => engine,
    cancelRun: (runId) => {
      stopped.push(runId);
      return Promise.resolve({ status: 'requested' });
    },
    forwarder: {
      watch: () => {},
      reconcile: () => Promise.resolve('not-needed'),
      drain: () => Promise.resolve(),
    },
    startAttempt: () => Promise.reject(new Error('never starts an attempt')),
    isClosing: () => false,
    ...extra,
  };
  return { control, diagnostics, stopped };
}
