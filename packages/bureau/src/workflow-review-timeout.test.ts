/**
 * COR-2240: a "Wait for a person" review that carries a `timeout` is still a review while it waits,
 * and a person's decision resumes it; when the timeout passes first the run continues with the
 * `{ timedOut: true }` marker and the review leaves Reviews.
 */
import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from '@lostgradient/testing/fake-timers';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import type { PendingHumanWaitReview } from './bureau-types/reviews';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  restoreRealTimers();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const reviewed = (timeout: string | number) => ({
  title: 'Timed review',
  trigger: { kind: 'manual' },
  steps: [
    { title: 'Approve', kind: 'await-signal', signal: 'approved', review: true, timeout },
    {
      title: 'Next',
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'editor', message: 'Carry on' },
    },
  ],
});

async function start(): Promise<WorkflowBureauHarness> {
  const harness = await startWorkflowBureau({ replies: { editor: () => 'ok' } });
  cleanups.push(() => harness.dispose());
  return harness;
}

const reviewsOf = (harness: WorkflowBureauHarness): PendingHumanWaitReview[] =>
  harness.bureau.reviews
    .list()
    .filter(
      (review): review is PendingHumanWaitReview =>
        review.kind === 'human-wait' && review.workflow !== undefined,
    );

describe('a workflow review with a timeout', () => {
  it('lists in Reviews while it waits, and a decision resumes the run', async () => {
    const harness = await start();
    await harness.putWorkflow('timed-review', reviewed('1h'));
    const { runId } = await harness.bureau.workflows!.start('timed-review', {
      owner: 'person:test',
    });
    await waitUntil(() => reviewsOf(harness).length === 1);
    const review = reviewsOf(harness)[0]!;
    expect(review).toMatchObject({ runId, signalName: 'approved', workflow: { step: 1 } });

    await harness.bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'person:test',
      payload: { note: 'go' },
    });

    await waitUntil(async () => {
      const run = await harness.bureau.durableEngine()!.get(runId);
      return run?.status === 'completed';
    });
    expect(harness.calls.at(-1)?.message).toContain('"note": "go"');
  });

  it('continues with the marker when the timeout passes first, and leaves Reviews', async () => {
    const harness = await start();
    await harness.putWorkflow('timed-out-review', reviewed('1h'));
    // AC1's "manual clock": fake timers are the only clock the race primitive honors (the engine's
    // own clock does not fire its sleep branch), installed before the run parks.
    useFakeTimers(Date.now());
    const { runId } = await harness.bureau.workflows!.start('timed-out-review', {
      owner: 'person:test',
    });
    await waitUntil(() => reviewsOf(harness).length === 1);
    await advanceTimersByTime(60 * 60 * 1000);
    await waitUntil(async () => {
      const run = await harness.bureau.durableEngine()!.get(runId);
      return run?.status === 'completed';
    });
    expect(harness.calls.at(-1)?.message).toContain('"timedOut": true');
    expect(reviewsOf(harness)).toEqual([]);
  });
});
