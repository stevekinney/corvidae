import { throwingRejectionOf } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';

import { goalFixture } from './bureau-fixtures.test-support.ts';
import {
  cancelGoal,
  createGoal,
  GOAL_STATUSES,
  goalHasEnded,
  listAllGoals,
  listGoals,
} from './bureau-goals.ts';
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
        idempotencyKey: 'key-1',
      }),
    );
    expect(refused).toThrow();
    expect(stub.callsTo('bureau.goals.create')[0]?.params).toEqual({
      idempotencyKey: 'key-1',
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

describe('every goal the Bureau holds', () => {
  test('is read a page at a time, following the offset until the Bureau has no more', async () => {
    const all = Array.from({ length: 5 }, (_, index) => goalFixture(`goal-${String(index)}`));
    stub = installBureauStub({
      'bureau.goals.list': (params) => {
        const offset = typeof params['offset'] === 'number' ? params['offset'] : 0;
        // The Bureau answers no more than two to a page, however many are asked for.
        const page = all.slice(offset, offset + 2);
        return { goals: page, nextOffset: offset + 2 < all.length ? offset + 2 : null };
      },
    });

    const goals = await listAllGoals();

    expect(goals.map((goal) => goal.goalRunId)).toEqual(all.map((goal) => goal.goalRunId));
    expect(stub.callsTo('bureau.goals.list').map((call) => call.params['offset'])).toEqual([
      0, 2, 4,
    ]);
  });

  test('is not read for ever from a Bureau whose offset does not move', async () => {
    stub = installBureauStub({
      'bureau.goals.list': () => ({ goals: [goalFixture('goal-0')], nextOffset: 0 }),
    });

    expect(await listAllGoals()).toHaveLength(1);
    expect(stub.callsTo('bureau.goals.list')).toHaveLength(1);
  });
});
