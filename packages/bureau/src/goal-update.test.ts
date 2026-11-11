/**
 * COR-2017 — `bureau.goals.update`: a goal's prompt, agent, validator, and attempt limit change for
 * the attempts it has not yet made, fenced on the revision the caller read. The store's own
 * compare-and-swap first, then the control plane over a real `createBureau`.
 */
import type { GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { createGoalState, type GoalState } from './goal-state';
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
import type { Bureau } from './types';

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

/** A goal whose first attempt is in flight and never ends on its own. */
async function runningGoal(bureau: Bureau, goalRunId = 'g1', maximumAttempts = 3) {
  await bureau.goals.create(
    goalRequest({ goalRunId, bounds: { maximumAttempts, maximumTotalSteps: 100 } }),
  );
  await pollUntil(async () => (await bureau.goals.get(goalRunId))?.status === 'running');
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

  it('refuses another agent even before the first attempt is recorded', async () => {
    const { store, state } = await pendingGoal();

    const refused = await store.updateConfiguration(
      'g',
      { agentName: 'helper', prompt: 'work harder' },
      NOW,
      state.revision,
    );

    expect(refused).toMatchObject({ status: 'rejected', reason: 'agent-fixed' });
    expect(await store.get('g')).toEqual(state);
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
    expect((await store.get('g'))?.objective.prompt).toBe(state.objective.prompt);
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
    expect((await bureau.goals.get('g1'))?.objective.prompt).toBe('work');
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

  it('refuses another agent, and takes the goal’s own beside a change that is allowed', async () => {
    const bureau = await boot({
      agents: {
        worker: workerAgent(hangUntilAborted),
        helper: workerAgent(hangUntilAborted, 'helper'),
      },
      validators: [createCheckValidator()],
    });
    await runningGoal(bureau);

    expect(await updateNow(bureau, 'g1', { agentName: 'helper' })).toMatchObject({
      outcome: 'rejected',
      code: 'agent-fixed',
    });
    expect(await updateNow(bureau, 'g1', { agentName: 'nobody' })).toMatchObject({
      outcome: 'rejected',
      code: 'agent-fixed',
    });
    expect((await bureau.goals.get('g1'))?.objective.agentName).toBe('worker');
    expect(
      await updateNow(bureau, 'g1', { agentName: 'worker', prompt: 'work harder' }),
    ).toMatchObject({ outcome: 'updated', goal: { objective: { agentName: 'worker' } } });
  });

  it('holds the attempt limit above the attempts opened, and fixes it while the last allowed attempt runs', async () => {
    const bureau = await boot({
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
    });
    await runningGoal(bureau, 'g1', 3);
    await runningGoal(bureau, 'g-last', 1);

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
    expect((await bureau.goals.get('g-last'))?.bounds.maximumAttempts).toBe(1);
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
    await pollUntil(async () => (await bureau.goals.get('g1'))?.status === 'running');

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
    expect((await bureau.goals.get('g1'))?.validator).toEqual(CHECK);
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
