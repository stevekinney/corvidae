/**
 * COR-851 — fixtures for the goal restart tests: booting bureaus over one
 * SQLite file, and writing a goal record into it the way a process that died
 * at a precise point would have left it.
 */

import type { Validator } from '@lostgradient/operative';
import { encode, resolveStorage, type Storage, textValueStore } from '@lostgradient/weft';

import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import {
  createGoalState,
  type DurableGoalAttempt,
  goalAttemptId,
  goalAttemptRunId,
  goalDecisionId,
  goalRecordKey,
  type GoalState,
  goalTransitionId,
} from '../goal-state';
import { createGoalStore, type GoalStore } from '../goal-store';
import type { BureauGoalRequest } from '../goal-types';
import { CATALOG_RUN_RECOVERY_KEY_PREFIX } from '../runtime-composition';
import type { Bureau } from '../types';
import { createDiagnostics, goalRequest } from './goal-fixtures.test-support';

export interface BootOptions<D extends AgentDefinitions> {
  readonly path: string;
  readonly agents: D;
  readonly validators?: readonly Validator[];
  readonly diagnostics?: ReturnType<typeof createDiagnostics>;
}

/** A bureau over `path` that recovers whatever an earlier process left behind. */
export async function bootOver<D extends AgentDefinitions>(options: BootOptions<D>) {
  const diagnostics = options.diagnostics ?? createDiagnostics();
  const bureau = await createBureau({
    agents: options.agents,
    ...(options.validators === undefined ? {} : { validators: options.validators }),
    storage: { type: 'sqlite', path: options.path },
    durableExecution: true,
    durableOwnership: { ownership: 'none' },
    onDiagnostic: diagnostics.onDiagnostic,
  });
  return { bureau: bureau as unknown as Bureau, diagnostics };
}

/** A direct view of the SQLite file: the goal store, and the raw keys beside it. */
export async function inspect(path: string) {
  const storage: Storage = await resolveStorage({ type: 'sqlite', path });
  const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
  const store: GoalStore = createGoalStore(kv);
  return {
    storage,
    kv,
    store,
    dispose: () => storage[Symbol.dispose](),
    /** Overwrites a goal record's text, as an operator repairing it would. */
    async overwrite(record: GoalState) {
      await kv.set(goalRecordKey(record.goalRunId), JSON.stringify(record));
    },
    /** A catalog-run recovery claim, as a start that died before its workflow existed left it. */
    async claimRun(
      runId: string,
      record: { agentName: string; definitionRevision: number; input: string },
    ) {
      await storage.put(
        `${CATALOG_RUN_RECOVERY_KEY_PREFIX}${runId}`,
        encode({ schemaVersion: 1, ...record }),
      );
    },
  };
}

type Inspection = Awaited<ReturnType<typeof inspect>>;

const NOW = '2026-10-02T12:00:00.000Z';

function attemptAt(goalRunId: string, index: number, overrides: Partial<DurableGoalAttempt> = {}) {
  return {
    attemptId: goalAttemptId(goalRunId, index),
    attemptIndex: index,
    runId: goalAttemptRunId(goalRunId, index),
    sessionId: goalAttemptRunId(goalRunId, index),
    startedAt: NOW,
    usage: { steps: 0, tokens: 0 },
    status: 'running',
    ...overrides,
  } satisfies DurableGoalAttempt;
}

/** A fresh `pending` record for the standard test goal. */
export function pendingGoal(overrides: Partial<BureauGoalRequest<'worker'>> = {}): GoalState {
  const request = goalRequest(overrides);
  return createGoalState({
    goalRunId: request.goalRunId ?? 'g1',
    identity: request.identity,
    objective: { agentName: request.agentName, prompt: request.prompt },
    validator: request.validator,
    conversationPolicy: request.conversationPolicy ?? { kind: 'continue' },
    retryPolicy: request.retryPolicy,
    bounds: request.bounds,
    principal: request.principal,
    now: NOW,
  });
}

/** Creates the record and walks it to `running` with attempt 0 recorded, as a controller would. */
export async function seedRunning(inspection: Inspection, goal = pendingGoal()) {
  const { goalRunId } = goal;
  await inspection.store.create(goal);
  const attempt = attemptAt(goalRunId, 0);
  await inspection.store.applyTransition({
    goalRunId,
    seq: 1,
    transitionId: goalTransitionId(goalRunId, 1),
    to: 'running',
    at: NOW,
    cause: 'attempt 0 started',
    attempt,
    usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
    active: {
      kind: 'attempt',
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      startedAt: NOW,
    },
  });
  return attempt;
}

/** Walks a seeded `running` goal on to `retrying`: attempt 0 failed retryably with feedback. */
export async function seedRetrying(inspection: Inspection, goal = pendingGoal()) {
  const { goalRunId } = goal;
  const attempt = await seedRunning(inspection, goal);
  await inspection.store.applyTransition({
    goalRunId,
    seq: 2,
    transitionId: goalTransitionId(goalRunId, 2),
    to: 'evaluating',
    at: NOW,
    cause: 'attempt 0 reached stop-condition',
    attempt: { ...attempt, status: 'evaluating', finishReason: 'stop-condition' },
    active: {
      kind: 'validation',
      attemptId: attempt.attemptId,
      validator: goal.validator,
      startedAt: NOW,
    },
  });
  await inspection.store.applyTransition({
    goalRunId,
    seq: 3,
    transitionId: goalTransitionId(goalRunId, 3),
    to: 'retrying',
    at: NOW,
    cause: 'retrying after a non-passing attempt',
    attempt: {
      ...attempt,
      status: 'failed',
      finishReason: 'stop-condition',
      completedAt: NOW,
      feedback: 'say done',
      validation: {
        identity: goal.validator,
        startedAt: NOW,
        completedAt: NOW,
        outcome: { kind: 'fail', feedback: 'say done', evidence: [], retryable: true },
        decisionId: goalDecisionId(attempt.attemptId),
      },
    },
    active: null,
  });
}

/**
 * Walks a pending record to `running` with no attempt behind it. A controller
 * that reads it cannot reason about it and fails, which is how a test makes a
 * controller end abnormally.
 */
export async function seedPoisoned(inspection: Inspection, goal = pendingGoal()) {
  await inspection.store.create(goal);
  await inspection.store.applyTransition({
    goalRunId: goal.goalRunId,
    seq: 1,
    transitionId: goalTransitionId(goal.goalRunId, 1),
    to: 'running',
    at: NOW,
    cause: 'poisoned',
  });
}
