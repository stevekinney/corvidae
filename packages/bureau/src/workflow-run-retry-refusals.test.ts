/**
 * COR-2424 — the retries `workflows.retryRun` refuses because the step the run failed at would only
 * fail the same way again: a `workflow` step (its child run is found again by its id, and failed), a
 * step inside a `parallel`, and a person's rejection at a review. Each leaves the run as it was.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';

import type { PendingHumanWaitReview } from './bureau-types/reviews';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { WorkflowRetryRefusedError } from './workflow-run-retry';

const harnesses: WorkflowBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

const OWNER = 'anonymous:local';

async function start(replies: Record<string, () => string>): Promise<WorkflowBureauHarness> {
  const harness = await startWorkflowBureau({
    overrides: { onDiagnostic: () => undefined },
    replies,
  });
  harnesses.push(harness);
  return harness;
}

async function failedRunOf(harness: WorkflowBureauHarness, file: string): Promise<string> {
  const { runId } = await harness.bureau.workflows!.start(file, { owner: OWNER });
  await waitUntil(
    async () => (await harness.bureau.workflows!.getRun(runId))?.status === 'failed',
    {
      message: `run ${runId} to fail`,
    },
  );
  return runId;
}

async function codeOfRefusal(work: Promise<unknown>): Promise<string> {
  const error = await rejectionOf(work);
  if (!(error instanceof WorkflowRetryRefusedError)) throw error;
  return error.code;
}

const failing = () => {
  throw new Error('the writer is down');
};

describe('a retry the failed step would only fail again', () => {
  it('is refused for a step inside a parallel step, and the run stays failed', async () => {
    const harness = await start({ writer: failing });
    await harness.putWorkflow('fan-out', {
      trigger: { kind: 'manual' },
      steps: [
        {
          title: 'Fan out',
          kind: 'parallel',
          branches: {
            first: [
              {
                title: 'Write it',
                kind: 'activity',
                handler: 'agent',
                input: { agent: 'writer', message: 'Write.' },
              },
            ],
          },
        },
      ],
    });
    const runId = await failedRunOf(harness, 'fan-out');
    // The parallel step is step 1 and its branch's step is step 2, the one the run failed at.
    expect(await codeOfRefusal(harness.bureau.workflows!.retryRun(runId, { step: 2 }))).toBe(
      'step-not-retryable',
    );
    expect((await harness.bureau.workflows!.getRun(runId))?.status).toBe('failed');
  });

  it('is refused for a run a person rejected at a review', async () => {
    const harness = await start({ editor: () => 'Published' });
    await harness.putWorkflow('reviewed', {
      title: 'Reviewed',
      trigger: { kind: 'manual' },
      steps: [
        {
          title: 'Approve the draft',
          kind: 'await-signal',
          signal: 'draft-approved',
          review: true,
        },
        {
          title: 'Publish',
          kind: 'activity',
          handler: 'agent',
          input: { agent: 'editor', message: 'Publish the draft' },
        },
      ],
    });
    const { runId } = await harness.bureau.workflows!.start('reviewed', { owner: 'person:test' });
    const reviewOf = (): PendingHumanWaitReview | undefined =>
      harness.bureau.reviews
        .list()
        .find(
          (review): review is PendingHumanWaitReview =>
            review.kind === 'human-wait' && review.runId === runId,
        );
    await waitUntil(() => reviewOf() !== undefined);
    await harness.bureau.reviews.resolve({
      id: reviewOf()!.id,
      decision: 'reject',
      principal: 'person:test',
      reason: 'Not yet',
    });
    await waitUntil(
      async () => (await harness.bureau.workflows!.getRun(runId))?.status === 'failed',
    );
    expect(await codeOfRefusal(harness.bureau.workflows!.retryRun(runId, { step: 1 }))).toBe(
      'step-not-retryable',
    );
    expect(harness.calls.some((call) => call.agent === 'editor')).toBe(false);
  });
});
