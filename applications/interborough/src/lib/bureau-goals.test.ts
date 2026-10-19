import { throwingRejectionOf } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';

import { cancelGoal, createGoal, GOAL_STATUSES, goalHasEnded, listGoals } from './bureau-goals.ts';
import { installBureauStub, type BureauStub } from './bureau-stub.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('a goal that has ended', () => {
  test('is one that succeeded, was exhausted, failed, or was canceled, and no other', () => {
    expect(GOAL_STATUSES.filter(goalHasEnded)).toEqual([
      'succeeded',
      'exhausted',
      'failed',
      'canceled',
    ]);
  });
});

describe('the Bureau’s goals', () => {
  test('are created with the bounds a goal needs, and nothing the form does not hold', async () => {
    stub = installBureauStub({
      'bureau.goals.create': () => {
        throw new Error('not reached');
      },
    });
    const refused = await throwingRejectionOf(
      createGoal({
        agentName: 'assistant',
        prompt: 'Say hello.',
        identity: { name: 'say-hello', version: '1' },
        validator: { name: 'never-passes', version: '1' },
        maximumAttempts: 3,
        maximumTotalSteps: 20,
      }),
    );
    expect(refused).toThrow();
    expect(stub.callsTo('bureau.goals.create')[0]?.params).toEqual({
      agentName: 'assistant',
      prompt: 'Say hello.',
      identity: { name: 'say-hello', version: '1' },
      validator: { name: 'never-passes', version: '1' },
      bounds: { maximumAttempts: 3, maximumTotalSteps: 20 },
    });
  });

  test('are listed a page at a time, and cancelled by the revision that was read', async () => {
    stub = installBureauStub({
      'bureau.goals.list': () => ({ goals: [], nextOffset: null }),
      'bureau.goals.cancel': () => ({
        goalRunId: 'g-1',
        outcome: 'canceled',
        status: 'canceled',
        revision: 9,
      }),
    });

    expect(await listGoals({ limit: 5, offset: 10 })).toEqual({ goals: [], nextOffset: null });
    expect(await cancelGoal('g-1', 8)).toMatchObject({ outcome: 'canceled', revision: 9 });
    await cancelGoal('g-1', undefined);

    expect(stub.callsTo('bureau.goals.list')[0]?.params).toEqual({ limit: 5, offset: 10 });
    expect(stub.callsTo('bureau.goals.cancel').map((call) => call.params)).toEqual([
      { goalRunId: 'g-1', expectedRevision: 8 },
      { goalRunId: 'g-1' },
    ]);
  });
});
