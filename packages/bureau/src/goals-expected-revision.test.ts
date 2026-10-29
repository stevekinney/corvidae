/**
 * COR-1482 — `bureau.goals.cancel` takes `expectedRevision`, compared against the goal record's
 * `revision` and, for the write itself, inside the store's compare-and-swap.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { createGoalState } from './goal-state';
import { createGoalStore } from './goal-store';
import {
  CHECK,
  createCheckValidator,
  goalRequest,
  hangUntilAborted,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import type { Bureau } from './types';

const open: Bureau[] = [];
afterEach(async () => {
  for (const bureau of open.splice(0)) await bureau.dispose();
});

async function boot(
  options: Parameters<typeof createBureau>[0] = {
    agents: { worker: workerAgent(hangUntilAborted) },
    validators: [createCheckValidator()],
  },
) {
  const bureau = await createBureau({
    storage: { type: 'memory' },
    durable: true,
    ...options,
  });
  open.push(bureau);
  return bureau;
}

describe('the goal store’s cancellation marker', () => {
  function pendingGoal() {
    const store = createGoalStore(textValueStore(new MemoryStorage()));
    const state = createGoalState({
      goalRunId: 'g',
      identity: { name: 'goal', version: '1' },
      objective: { agentName: 'worker', prompt: 'work' },
      validator: CHECK,
      conversationPolicy: { kind: 'continue' },
      bounds: { maximumAttempts: 1, maximumTotalTokens: 10 },
      now: '2026-10-02T00:00:00.000Z',
    });
    return { store, state };
  }

  it('is refused as a revision mismatch, writing nothing, when the record is not at expectedRevision', async () => {
    const { store, state } = pendingGoal();
    await store.create(state);

    const refused = await store.requestCancellation(
      'g',
      { requestedAt: '2026-10-02T00:00:01.000Z' },
      '2026-10-02T00:00:01.000Z',
      state.revision + 1,
    );

    expect(refused).toMatchObject({ status: 'revision-mismatch' });
    const awaited8 = await store.get('g');
    expect(awaited8?.cancellation).toBeUndefined();
    const awaited9 = await store.get('g');
    expect(awaited9?.revision).toBe(state.revision);
  });

  it('writes the marker, and advances the revision, when the record is at expectedRevision', async () => {
    const { store, state } = pendingGoal();
    await store.create(state);

    const marked = await store.requestCancellation(
      'g',
      { requestedAt: '2026-10-02T00:00:01.000Z' },
      '2026-10-02T00:00:01.000Z',
      state.revision,
    );

    expect(marked.status).toBe('updated');
    const awaited10 = await store.get('g');
    expect(awaited10?.revision).toBe(state.revision + 1);
  });
});

describe('bureau.goals.cancel with expectedRevision', () => {
  it('answers stale-revision for another revision, leaves the goal as it was, and cancels at the current one', async () => {
    const bureau = await boot();
    await bureau.goals.create(goalRequest({ goalRunId: 'g-guarded' }));
    const before = await bureau.goals.get('g-guarded');

    const stale = await bureau.goals.cancel('g-guarded', {
      expectedRevision: before!.revision - 1,
    });
    expect(stale).toMatchObject({ outcome: 'stale-revision' });
    expect(stale.outcome === 'stale-revision' && stale.goal.revision).toBe(before!.revision);
    const awaited11 = await bureau.goals.get('g-guarded');
    expect(awaited11?.cancellation).toBeUndefined();

    const canceled = await bureau.goals.cancel('g-guarded', {
      expectedRevision: before!.revision,
    });
    expect(['canceled', 'cancellation-pending']).toContain(canceled.outcome);
    const awaited12 = await bureau.goals.get('g-guarded');
    expect(awaited12?.cancellation).toBeDefined();
  });

  it('is compared before a goal that is already over answers anything else', async () => {
    const bureau = await boot();
    await bureau.goals.create(goalRequest({ goalRunId: 'g-over' }));
    await bureau.goals.cancel('g-over');
    const over = await bureau.goals.get('g-over');

    const stale = await bureau.goals.cancel('g-over', { expectedRevision: over!.revision + 5 });

    expect(stale).toMatchObject({ outcome: 'stale-revision' });
  });

  it('takes an expectedRevision that is not a revision as none, like every other untyped option', async () => {
    const bureau = await boot();
    await bureau.goals.create(goalRequest({ goalRunId: 'g-untyped' }));

    const outcome = await bureau.goals.cancel('g-untyped', { expectedRevision: 'x' } as never);

    expect(['canceled', 'cancellation-pending']).toContain(outcome.outcome);
  });
});
