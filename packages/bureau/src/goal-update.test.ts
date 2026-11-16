/**
 * COR-2017 — `bureau.goals.update`: a goal's prompt, agent, validator, and attempt limit change for
 * the attempts it has not yet made, fenced on the revision the caller read. The store's own
 * compare-and-swap first, then the control plane over a real `createBureau`.
 */
import type { GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import {
  attemptAgentName,
  createGoalState,
  goalAttemptId,
  goalAttemptRunId,
  goalSessionId,
  type GoalState,
  goalTransitionId,
  isGoalState,
} from './goal-state';
import { createGoalStore } from './goal-store';
import type { BureauGoalUpdateRequest } from './goal-types';
import {
  cancelUntilSettled,
  CHECK,
  createCheckValidator,
  createLatch,
  goalRequest,
  hangUntilAborted,
  pollUntil,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import type { Bureau } from './bureau-types/facade';

const open: Bureau[] = [];
afterEach(async () => {
  for (const bureau of open.splice(0)) await bureau.dispose();
});

async function boot(options: Parameters<typeof createBureau>[0]) {
  const bureau = await createBureau({
    storage: new MemoryStorage(),
    durable: true,
    ...options,
  });
  open.push(bureau);
  return bureau;
}

/** The bounds a test goal runs under unless the test names its own. */
const GOAL_BOUNDS = { maximumAttempts: 3, maximumTotalSteps: 100 };

/** A goal whose first attempt is in flight and never ends on its own. */
async function runningGoal(bureau: Bureau, goalRunId = 'g1', bounds = GOAL_BOUNDS) {
  await bureau.goals.create(goalRequest({ goalRunId, bounds }));
  await pollUntil(async () => {
    const goal = await bureau.goals.get(goalRunId);
    return goal?.status === 'running';
  });
  return (await bureau.goals.get(goalRunId))!;
}

/**
 * Updates a goal against the revision it is at when the update is sent. A controller transition
 * can land between the read and the write; the update is then refused as stale, writing nothing,
 * and is sent again against the revision that transition left.
 */
async function updateNow(
  bureau: Bureau,
  goalRunId: string,
  change: Omit<BureauGoalUpdateRequest, 'expectedRevision'>,
) {
  for (;;) {
    const current = await bureau.goals.get(goalRunId);
    if (current === undefined) throw new Error(`No goal "${goalRunId}"`);
    const outcome = await bureau.goals.update(goalRunId, {
      ...change,
      expectedRevision: current.revision,
    });
    if (outcome.outcome !== 'stale-revision') return outcome;
  }
}

describe('the goal store’s configuration update', () => {
  const NOW = '2026-10-02T00:00:01.000Z';

  async function pendingGoal() {
    const store = createGoalStore(textValueStore(new MemoryStorage()));
    const state = createGoalState({
      goalRunId: 'g',
      identity: { name: 'goal', version: '1' },
      objective: { agentName: 'worker', prompt: 'work' },
      validator: CHECK,
      conversationPolicy: { kind: 'continue' },
      bounds: { maximumAttempts: 2, maximumTotalTokens: 10 },
      now: '2026-10-02T00:00:00.000Z',
    });
    await store.create(state);
    return { store, state };
  }

  it('writes the prompt, validator and limit of a pending goal, advancing the revision and nothing a transition owns', async () => {
    const { store, state } = await pendingGoal();

    const updated = await store.updateConfiguration(
      'g',
      {
        prompt: 'work harder',
        agentName: 'worker',
        validator: { name: 'check', version: '2' },
        maximumAttempts: 4,
      },
      NOW,
      state.revision,
    );

    expect(updated.status).toBe('updated');
    const stored = (await store.get('g'))!;
    expect(stored).toMatchObject({
      revision: state.revision + 1,
      transitionSeq: state.transitionSeq,
      status: 'pending',
      objective: { agentName: 'worker', prompt: 'work harder' },
      validator: { name: 'check', version: '2' },
      bounds: { maximumAttempts: 4, maximumTotalTokens: 10 },
      updatedAt: NOW,
    });
    expect(stored.auditLog).toEqual(state.auditLog);
    expect(stored.currentTransition).toEqual(state.currentTransition);
  });

  it('writes nothing for another revision, whatever the patch', async () => {
    const { store, state } = await pendingGoal();

    const refused = await store.updateConfiguration(
      'g',
      { prompt: 'work harder' },
      NOW,
      state.revision + 1,
    );

    expect(refused).toMatchObject({ status: 'revision-mismatch' });
    expect(await store.get('g')).toEqual(state);
  });

  it('answers unchanged, writing nothing, for a patch the goal already says', async () => {
    const { store, state } = await pendingGoal();

    const same = await store.updateConfiguration(
      'g',
      { prompt: 'work', agentName: 'worker', validator: CHECK, maximumAttempts: 2 },
      NOW,
      state.revision,
    );

    expect(same.status).toBe('unchanged');
    expect(await store.get('g')).toEqual(state);
  });

  it('refuses a patch the record would not decode with, instead of throwing', async () => {
    const { store, state } = await pendingGoal();

    const refused = await store.updateConfiguration(
      'g',
      { validator: { name: '', version: '1' } },
      NOW,
      state.revision,
    );

    expect(refused).toMatchObject({ status: 'rejected', reason: 'invalid-record' });
    expect(await store.get('g')).toEqual(state);
  });

  it('refuses another agent while no attempt is in flight, even before the first attempt is recorded', async () => {
    const { store, state } = await pendingGoal();

    const refused = await store.updateConfiguration(
      'g',
      { agentName: 'helper', prompt: 'work harder' },
      NOW,
      state.revision,
    );

    expect(refused).toMatchObject({ status: 'rejected', reason: 'agent-between-attempts' });
    expect(await store.get('g')).toEqual(state);
  });

  /** A goal whose attempt 0 is in flight, written without a per-attempt agent as records were before it existed. */
  async function goalWithAttemptInFlight() {
    const { store } = await pendingGoal();
    const opened = await store.applyTransition({
      goalRunId: 'g',
      seq: 1,
      transitionId: goalTransitionId('g', 1),
      to: 'running',
      at: NOW,
      cause: 'attempt-started',
      attempt: {
        attemptId: goalAttemptId('g', 0),
        attemptIndex: 0,
        runId: goalAttemptRunId('g', 0),
        sessionId: goalSessionId('g', 0),
        startedAt: NOW,
        usage: { steps: 0, tokens: 0 },
        status: 'running',
      },
      usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
      active: {
        kind: 'attempt',
        attemptId: goalAttemptId('g', 0),
        runId: goalAttemptRunId('g', 0),
        startedAt: NOW,
      },
    });
    if (opened.status !== 'applied') throw new Error(`expected applied, got ${opened.status}`);
    return { store, record: opened.record };
  }

  /** What the controller commits when it ends attempt 0 and opens attempt 1: no agent in the patch. */
  function nextAttemptTransition(seq: number, index: number) {
    return {
      goalRunId: 'g',
      seq,
      transitionId: goalTransitionId('g', seq),
      to: 'running' as const,
      at: NOW,
      cause: 'attempt-started',
      attempt: {
        attemptId: goalAttemptId('g', index),
        attemptIndex: index,
        runId: goalAttemptRunId('g', index),
        sessionId: goalSessionId('g', 0),
        startedAt: NOW,
        usage: { steps: 0, tokens: 0 },
        status: 'running' as const,
      },
    };
  }

  it('reads an attempt of a record written before attempts carried an agent as the goal’s agent', async () => {
    const { record } = await goalWithAttemptInFlight();

    expect(record.attempts[0]).not.toHaveProperty('agentName');
    expect(isGoalState(record)).toBe(true);
    expect(attemptAgentName(record, 0)).toBe('worker');
    // An attempt not yet opened is the goal's current agent.
    expect(attemptAgentName(record, 1)).toBe('worker');
  });

  it('changes the agent while an attempt is in flight, stamping every attempt opened with the agent it ran as', async () => {
    const { store, record } = await goalWithAttemptInFlight();

    const changed = await store.updateConfiguration(
      'g',
      { agentName: 'helper' },
      NOW,
      record.revision,
    );

    expect(changed.status).toBe('updated');
    const stored = (await store.get('g'))!;
    expect(isGoalState(stored)).toBe(true);
    expect(stored.objective.agentName).toBe('helper');
    // The attempt in flight keeps the agent it was opened under, and every check reads it.
    expect(stored.attempts[0]).toMatchObject({ agentName: 'worker' });
    expect(attemptAgentName(stored, 0)).toBe('worker');
    expect(attemptAgentName(stored, 1)).toBe('helper');
  });

  it('stamps the next attempt with the goal’s agent, keeps a stamp a replacement does not carry, and leaves an unchanged goal unstamped', async () => {
    const unchanged = await goalWithAttemptInFlight();
    const plain = await unchanged.store.applyTransition(nextAttemptTransition(2, 1));
    expect(plain.status).toBe('applied');
    expect((await unchanged.store.get('g'))!.attempts[1]).not.toHaveProperty('agentName');

    const { store, record } = await goalWithAttemptInFlight();
    await store.updateConfiguration('g', { agentName: 'helper' }, NOW, record.revision);
    // The controller's patch for attempt 1 carries no agent: the store records the goal's own.
    const opened = await store.applyTransition(nextAttemptTransition(2, 1));
    expect(opened.status).toBe('applied');
    const stored = (await store.get('g'))!;
    expect(stored.attempts.map((attempt) => attempt.agentName)).toEqual(['worker', 'helper']);

    // A controller rewriting attempt 0 (its patch has no agent) does not drop the one it ran as.
    const rewritten = await store.applyTransition({
      ...nextAttemptTransition(3, 0),
      to: 'evaluating',
      attempt: { ...nextAttemptTransition(3, 0).attempt, status: 'evaluating' },
    });
    expect(rewritten.status).toBe('applied');
    expect((await store.get('g'))!.attempts[0]).toMatchObject({ agentName: 'worker' });
  });

  it('gives the retry after a prompt edit under continue the edit, once', async () => {
    const { store, record } = await goalWithAttemptInFlight();
    expect(record.objective).not.toHaveProperty('promptRevisedAtAttempt');

    await store.updateConfiguration('g', { prompt: 'work harder' }, NOW, record.revision);

    const stored = (await store.get('g'))!;
    expect(isGoalState(stored)).toBe(true);
    // One attempt was opened, so the next attempt (index 1) is the first to be given the edit.
    expect(stored.objective).toMatchObject({ prompt: 'work harder', promptRevisedAtAttempt: 1 });
    // A pending goal has opened no attempt, so its first attempt simply runs the new prompt.
    const { store: pendingStore, state } = await pendingGoal();
    await pendingStore.updateConfiguration('g', { prompt: 'work harder' }, NOW, state.revision);
    expect((await pendingStore.get('g'))!.objective).not.toHaveProperty('promptRevisedAtAttempt');
  });

  it('refuses a goal whose cancellation is recorded', async () => {
    const { store, state } = await pendingGoal();
    await store.requestCancellation('g', { requestedAt: NOW }, NOW);
    const marked = (await store.get('g'))!;

    const refused = await store.updateConfiguration(
      'g',
      { prompt: 'work harder' },
      NOW,
      marked.revision,
    );

    expect(refused).toMatchObject({ status: 'rejected', reason: 'cancellation-requested' });
    expect(await store.get('g')).toHaveProperty('objective.prompt', state.objective.prompt);
  });
});

describe('bureau.goals.update on a running goal', () => {
  it('changes the prompt and the attempt limit, leaving the attempt in flight as it started', async () => {
    const bureau = await boot({
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
    });
    const before = await runningGoal(bureau);

    const outcome = await updateNow(bureau, 'g1', { prompt: 'work harder', maximumAttempts: 5 });

    expect(outcome.outcome).toBe('updated');
    const after = (await bureau.goals.get('g1'))!;
    expect(after.objective.prompt).toBe('work harder');
    expect(after.bounds.maximumAttempts).toBe(5);
    expect(after.status).toBe('running');
    expect(after.transitionSeq).toBe(before.transitionSeq);
    expect(after.attempts.map(({ runId, status }) => ({ runId, status }))).toEqual(
      before.attempts.map(({ runId, status }) => ({ runId, status })),
    );
  });

  it('answers stale-revision for a revision the goal has moved past, and writes nothing', async () => {
    const bureau = await boot({
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
    });
    const before = await runningGoal(bureau);

    const stale = await bureau.goals.update('g1', {
      prompt: 'work harder',
      expectedRevision: before.revision - 1,
    });

    expect(stale).toMatchObject({ outcome: 'stale-revision', goal: { revision: before.revision } });
    expect(await bureau.goals.get('g1')).toHaveProperty('objective.prompt', 'work');
  });

  it('refuses a change that names no field', async () => {
    const bureau = await boot({
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
    });
    const before = await runningGoal(bureau);

    expect(await bureau.goals.update('g1', { expectedRevision: before.revision })).toMatchObject({
      outcome: 'rejected',
      code: 'invalid-configuration',
    });
  });

  it('changes the agent of a goal whose attempt is in flight, and the attempt in flight keeps the agent it ran as', async () => {
    const bureau = await boot({
      agents: {
        worker: workerAgent(hangUntilAborted),
        helper: workerAgent(hangUntilAborted, 'helper'),
      },
      validators: [createCheckValidator()],
    });
    const before = await runningGoal(bureau);

    const outcome = await updateNow(bureau, 'g1', { agentName: 'helper' });

    expect(outcome).toMatchObject({
      outcome: 'updated',
      goal: { objective: { agentName: 'helper' } },
    });
    const after = (await bureau.goals.get('g1'))!;
    expect(after.attempts).toHaveLength(before.attempts.length);
    // Every ownership, fence and session check reads the attempt's own agent, so the run in flight
    // is still the goal's: its attempt reads `worker`, the goal's next one `helper`.
    expect(after.attempts.map((_, index) => attemptAgentName(after, index))).toEqual(
      before.attempts.map(() => 'worker'),
    );
    expect(attemptAgentName(after, after.attempts.length)).toBe('helper');
    expect(after.status).toBe('running');
  });

  it('answers an agent the catalog lacks as agent-not-found, and takes the goal’s own beside a change that is allowed', async () => {
    const bureau = await boot({
      agents: {
        worker: workerAgent(hangUntilAborted),
        helper: workerAgent(hangUntilAborted, 'helper'),
      },
      validators: [createCheckValidator()],
    });
    await runningGoal(bureau);

    expect(await updateNow(bureau, 'g1', { agentName: 'nobody' })).toMatchObject({
      outcome: 'rejected',
      code: 'agent-not-found',
    });
    expect(await bureau.goals.get('g1')).toHaveProperty('objective.agentName', 'worker');
    expect(
      await updateNow(bureau, 'g1', { agentName: 'worker', prompt: 'work harder' }),
    ).toMatchObject({ outcome: 'updated', goal: { objective: { agentName: 'worker' } } });
  });

  it('holds the attempt limit above the attempts opened, and fixes it while the last allowed attempt runs', async () => {
    const bureau = await boot({
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
    });
    await runningGoal(bureau, 'g1');
    await runningGoal(bureau, 'g-last', { ...GOAL_BOUNDS, maximumAttempts: 1 });

    expect(await updateNow(bureau, 'g1', { maximumAttempts: 1 })).toMatchObject({
      outcome: 'rejected',
      code: 'attempt-limit-too-low',
    });
    expect(await updateNow(bureau, 'g1', { maximumAttempts: 2 })).toMatchObject({
      outcome: 'updated',
    });
    expect(await updateNow(bureau, 'g-last', { maximumAttempts: 2 })).toMatchObject({
      outcome: 'rejected',
      code: 'attempt-limit-fixed',
    });
    expect(await bureau.goals.get('g-last')).toHaveProperty('bounds.maximumAttempts', 1);
    expect(await updateNow(bureau, 'g1', { maximumAttempts: 257 })).toMatchObject({
      outcome: 'rejected',
      code: 'invalid-configuration',
    });
  });

  it('refuses a validator the Bureau lacks, and one without the determinism the goal requires', async () => {
    const bureau = await boot({
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [
        createCheckValidator(),
        createCheckValidator({ version: '2', determinism: 'stochastic' }),
      ],
    });
    await bureau.goals.create(goalRequest({ requireDeterministicValidation: true }));
    await pollUntil(async () => {
      const goal = await bureau.goals.get('g1');
      return goal?.status === 'running';
    });

    expect(
      await updateNow(bureau, 'g1', { validator: { name: 'absent', version: '1' } }),
    ).toMatchObject({ outcome: 'rejected', code: 'validator-missing' });
    expect(
      await updateNow(bureau, 'g1', { validator: { name: 'check', version: '9' } }),
    ).toMatchObject({
      outcome: 'rejected',
      code: 'validator-version-mismatch',
      availableVersions: ['1', '2'],
    });
    expect(
      await updateNow(bureau, 'g1', { validator: { name: 'check', version: '2' } }),
    ).toMatchObject({ outcome: 'rejected', code: 'unsupported-validation' });
    expect(await bureau.goals.get('g1')).toHaveProperty('validator', CHECK);
  });

  it('answers a goal another principal owns as one that does not exist', async () => {
    const bureau = await boot({
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
    });
    await bureau.goals.create(goalRequest({ principal: 'api-key:alice' }));
    const goal = (await bureau.goals.get('g1'))!;

    expect(
      await bureau.goals.update('g1', {
        prompt: 'work harder',
        expectedRevision: goal.revision,
        principal: 'api-key:bob',
      }),
    ).toEqual({ outcome: 'not-found' });
  });

  it('refuses a goal that has ended', async () => {
    const bureau = await boot({
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
    });
    await runningGoal(bureau);
    await cancelUntilSettled(bureau);

    expect(await updateNow(bureau, 'g1', { prompt: 'work harder' })).toMatchObject({
      outcome: 'rejected',
      code: 'terminal',
    });
  });
});

describe('bureau.goals.update and the attempts already made', () => {
  it('checks the next attempt against the new validator and keeps the one an earlier attempt ran against', async () => {
    const second = createLatch();
    let calls = 0;
    // The first attempt fails its check, so the goal retries; the retry waits for the update.
    const generate: GenerateFunction = async () => {
      calls += 1;
      if (calls === 1) return { content: 'not yet', toolCalls: [] };
      await second.promise;
      return { content: 'done', toolCalls: [] };
    };
    const bureau = await boot({
      agents: { worker: workerAgent(generate) },
      validators: [createCheckValidator(), createCheckValidator({ version: '2' })],
    });
    await bureau.goals.create(goalRequest());
    await pollUntil(async () => {
      const goal = await bureau.goals.get('g1');
      return goal?.status === 'running' && goal.attempts.length === 2;
    });

    expect(
      await updateNow(bureau, 'g1', { validator: { name: 'check', version: '2' } }),
    ).toMatchObject({ outcome: 'updated' });
    second.release();

    let ended: GoalState | undefined;
    await pollUntil(async () => {
      ended = await bureau.goals.get('g1');
      return ended?.status === 'succeeded';
    });
    expect(ended?.attempts.map((attempt) => attempt.validation?.identity)).toEqual([
      { name: 'check', version: '1' },
      { name: 'check', version: '2' },
    ]);
  });
});
