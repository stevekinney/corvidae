/**
 * COR-1622 — a fire's seed state is bounded: held while the fire is in flight, gone once it has
 * settled.
 */
import { stopWhen, createAgent } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { fireReviewSeedsOf } from './fire-review-seeds';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  askingGenerate,
  createScheduleFireHarness,
  fireOnce,
  pollUntil,
  reviewOf,
} from './schedule-fire-fixtures.test-support';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});

describe('a fire’s seed state', () => {
  it('is held while the fire is in flight and gone once it has settled', async () => {
    const bureau = await harness.open({
      storage: await harness.sqliteStorage(harness.nextDatabasePath()),
      agents: {
        default: createAgent({
          generate: askingGenerate(),
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
    });
    const seeds = fireReviewSeedsOf(bureau);
    const { fireId } = await fireOnce(bureau, OWNER.alice, 'closes-seed-bounded');
    const review = await reviewOf(bureau, fireId);
    await pollUntil(() => (seeds.has(fireId) ? true : undefined), 'the fire’s seed read');

    await bureau.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: OWNER.alice,
      payload: 'staging',
    });
    await pollUntil(async () => {
      const task = await bureau.tasks.get(fireId);
      return task?.status === 'completed' ? true : undefined;
    }, 'the fire to complete');
    await pollUntil(() => (seeds.has(fireId) ? undefined : true), 'the seed read to be dropped');

    expect(seeds.size()).toBe(0);
  });
});
