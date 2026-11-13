/**
 * COR-2238: rejecting a "Wait for a person" review ends the run as `failed` with the code
 * `review-rejected`, without running a later step; approving or denying continues, as before. The
 * runs list narrows to rejected runs by `errorCode`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStorage } from '@lostgradient/storage';
import { principalFromApiKey } from '@lostgradient/weft';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { BureauError } from './bureau-errors';
import { createMemoryAssetStorage } from './assets/storage';
import { createBureauHandler } from './http/create-bureau-handler';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import type { PendingHumanWaitReview } from './bureau-types/reviews';
import { errorCodeOf } from './workflow-schema';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const REVIEWED = {
  title: 'Reviewed',
  trigger: { kind: 'manual' },
  steps: [
    { title: 'Approve the draft', kind: 'await-signal', signal: 'draft-approved', review: true },
    {
      title: 'Publish',
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'editor', message: 'Publish the draft' },
    },
  ],
};

async function start(
  options: Parameters<typeof startWorkflowBureau>[0] = {},
): Promise<WorkflowBureauHarness> {
  const harness = await startWorkflowBureau(options);
  cleanups.push(() => harness.dispose());
  return harness;
}

function reviewsOf(harness: WorkflowBureauHarness): PendingHumanWaitReview[] {
  return harness.bureau.reviews
    .list()
    .filter(
      (review): review is PendingHumanWaitReview =>
        review.kind === 'human-wait' && review.workflow !== undefined,
    );
}

async function atReview(
  harness: WorkflowBureauHarness,
  id = 'reviewed',
): Promise<{ runId: string; review: PendingHumanWaitReview }> {
  await harness.putWorkflow(id, REVIEWED);
  const { runId } = await harness.bureau.workflows!.start(id, { owner: 'person:test' });
  await waitUntil(() => reviewsOf(harness).some((review) => review.runId === runId));
  return { runId, review: reviewsOf(harness).find((review) => review.runId === runId)! };
}

async function stateOf(harness: WorkflowBureauHarness, runId: string) {
  return harness.bureau.durableEngine()!.get(runId);
}

async function statusOf(harness: WorkflowBureauHarness, runId: string): Promise<string> {
  const state = await stateOf(harness, runId);
  return state?.status ?? 'missing';
}

async function errorCodeOfRun(harness: WorkflowBureauHarness, runId: string) {
  const state = await stateOf(harness, runId);
  return errorCodeOf(state?.errorStack);
}

type Row = {
  readonly decision: 'approve' | 'deny' | 'reject';
  readonly status: 'completed' | 'failed';
  readonly published: boolean;
};

const rows: readonly Row[] = [
  { decision: 'approve', status: 'completed', published: true },
  { decision: 'deny', status: 'completed', published: true },
  { decision: 'reject', status: 'failed', published: false },
];

describe('resolving a workflow review (COR-2238)', () => {
  for (const row of rows) {
    it(`ends the run ${row.status} when the decision is ${row.decision}`, async () => {
      const harness = await start({ replies: { editor: () => 'Published' } });
      const { runId, review } = await atReview(harness);

      await harness.bureau.reviews.resolve({
        id: review.id,
        decision: row.decision,
        principal: 'person:test',
        ...(row.decision === 'approve' ? { payload: { note: 'Ship it' } } : { reason: 'Not yet' }),
      });

      await waitUntil(async () => {
        const state = await stateOf(harness, runId);
        return state?.status === row.status;
      });
      expect(harness.calls.some((call) => call.agent === 'editor')).toBe(row.published);
      const detail = await harness.bureau.workflows!.getRun(runId);
      if (row.status === 'failed') {
        expect(detail?.error).toBe('review-rejected');
        const final = await stateOf(harness, runId);
        expect(errorCodeOf(final?.errorStack)).toBe('review-rejected');
      } else {
        const final = await stateOf(harness, runId);
        expect(errorCodeOf(final?.errorStack)).toBeNull();
      }
    });
  }

  it('ends a run recovered after a restart at the review the same way', async () => {
    const storage = new MemoryStorage();
    const directory = await mkdtemp(join(tmpdir(), 'bureau-workflow-rejection-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const first = await start({ directory, overrides: { storage } });
    const { runId, review } = await atReview(first);
    await first.bureau.dispose();

    const second = await start({ directory, overrides: { storage } });
    await waitUntil(() => reviewsOf(second).some((entry) => entry.id === review.id));
    await second.bureau.reviews.resolve({
      id: review.id,
      decision: 'reject',
      principal: 'person:test',
      reason: 'Not yet',
    });

    await waitUntil(async () => {
      const state = await stateOf(second, runId);
      return state?.status === 'failed';
    });
    expect(second.calls.some((call) => call.agent === 'editor')).toBe(false);
    const final = await stateOf(second, runId);
    expect(errorCodeOf(final?.errorStack)).toBe('review-rejected');
  });

  it('ends a run on a retained revision the same way, after the file moved on without the review', async () => {
    const storage = new MemoryStorage();
    const directory = await mkdtemp(join(tmpdir(), 'bureau-workflow-rejection-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const first = await start({ directory, overrides: { storage } });
    const { runId, review } = await atReview(first);
    // The file changes to a plain wait: the instance stays on the revision it began on, whose
    // saved steps (read from the revision ledger, not the file) still say that step is a review.
    await first.putWorkflow('reviewed', {
      ...REVIEWED,
      steps: [{ kind: 'await-signal', signal: 'other' }, REVIEWED.steps[1]],
    });
    await first.bureau.dispose();

    const second = await start({ directory, overrides: { storage } });
    await waitUntil(() => reviewsOf(second).some((entry) => entry.id === review.id));
    await second.bureau.reviews.resolve({
      id: review.id,
      decision: 'reject',
      principal: 'person:test',
      reason: 'Not yet',
    });

    await waitUntil(async () => (await statusOf(second, runId)) === 'failed');
    expect(second.calls.some((call) => call.agent === 'editor')).toBe(false);
    expect(await errorCodeOfRun(second, runId)).toBe('review-rejected');
  });
});

describe('which waits a rejection ends (COR-2238, matrix rows R7 and R8)', () => {
  const rejection = { __abRejected: true, reason: 'Not yet' };

  it('R7: leaves a plain await-signal alone, so the payload reaches the next step as before', async () => {
    const harness = await start({ replies: { editor: () => 'Published' } });
    await harness.putWorkflow('plain-wait', {
      title: 'Plain wait',
      trigger: { kind: 'manual' },
      steps: [
        { kind: 'await-signal', signal: 'go' },
        {
          kind: 'activity',
          handler: 'agent',
          input: { agent: 'editor', message: 'Publish the draft' },
        },
      ],
    });
    const { runId } = await harness.bureau.workflows!.start('plain-wait', { owner: 'person:test' });
    await waitUntil(async () => {
      const state = await stateOf(harness, runId);
      return (state?.waitingForSignals?.length ?? 0) > 0;
    });

    await harness.bureau.durableEngine()!.signal(runId, 'go', rejection);

    await waitUntil(async () => (await statusOf(harness, runId)) === 'completed');
    expect(harness.calls.at(-1)?.message).toContain('"__abRejected": true');
    expect(await errorCodeOfRun(harness, runId)).toBeNull();
  });

  it('R8: ends the run for a rejection sent by hand to a review, whoever sends it', async () => {
    const harness = await start({ replies: { editor: () => 'Published' } });
    const { runId } = await atReview(harness);

    await harness.bureau.durableEngine()!.signal(runId, 'draft-approved', rejection);

    await waitUntil(async () => (await statusOf(harness, runId)) === 'failed');
    expect(harness.calls.some((call) => call.agent === 'editor')).toBe(false);
    expect(await errorCodeOfRun(harness, runId)).toBe('review-rejected');
    expect(reviewsOf(harness)).toEqual([]);
  });

  it('R8: still continues for a payload on a review that only looks like a rejection', async () => {
    const harness = await start({ replies: { editor: () => 'Published' } });
    const { runId } = await atReview(harness);

    await harness.bureau.durableEngine()!.signal(runId, 'draft-approved', { __abRejected: 'yes' });

    await waitUntil(async () => (await statusOf(harness, runId)) === 'completed');
    expect(harness.calls.some((call) => call.agent === 'editor')).toBe(true);
  });
});

describe('what a rejected run leaves behind (COR-2238, matrix rows R10, R11, R13 and R21)', () => {
  /**
   * R2 and R6. The run fails as soon as the rejection payload is consumed, before any later step is
   * yielded: `runAwaitSignal` throws on the value the wait returned, and a replay returns the same
   * recorded value from the checkpoint and throws at the same line, so no later step can start on
   * either side of a crash. That is a construction argument, not a test: a crash between the
   * checkpoint of the payload and the throw has nothing to observe, because the throw yields nothing.
   */
  it('R10 and R13: keeps the review record and audit, and reads back as failed with the code as its error', async () => {
    const harness = await start({ replies: { editor: () => 'Published' } });
    const { runId, review } = await atReview(harness);

    await harness.bureau.reviews.resolve({
      id: review.id,
      decision: 'reject',
      principal: 'person:test',
      reason: 'Wrong release',
    });
    await waitUntil(async () => (await statusOf(harness, runId)) === 'failed');

    expect(await harness.bureau.reviews.get(review.id)).toMatchObject({
      status: 'rejected',
      resolvedBy: 'person:test',
      resolutionReason: 'Wrong release',
    });
    const records = await harness.bureau.internals.auditTrail!.query({ runId });
    expect(records.filter((record) => record.type.startsWith('review.human-wait.'))).toEqual([
      expect.objectContaining({ runId, type: 'review.human-wait.rejected' }),
    ]);
    // `finishReason` is the closed enum of schema failures: a rejection is not one, so it stays
    // null and the code is the run's `error` (and the `errorCode` filter of `runs.list`).
    expect(await harness.bureau.workflows!.getRun(runId)).toMatchObject({
      status: 'failed',
      error: 'review-rejected',
      finishReason: null,
    });
  });

  it('R11: refuses a second resolve, NOT_FOUND for the same decision and CONFLICT for another', async () => {
    const harness = await start({ replies: { editor: () => 'Published' } });
    const { runId, review } = await atReview(harness);
    const reject = {
      id: review.id,
      decision: 'reject' as const,
      principal: 'person:test',
      reason: 'Wrong release',
    };
    await harness.bureau.reviews.resolve(reject);
    await waitUntil(async () => (await statusOf(harness, runId)) === 'failed');

    const again = await harness.bureau.reviews.resolve(reject).catch((error: unknown) => error);
    expect((again as BureauError).code).toBe('NOT_FOUND');
    const other = await harness.bureau.reviews
      .resolve({ id: review.id, decision: 'approve', principal: 'person:test', payload: {} })
      .catch((error: unknown) => error);
    expect((other as BureauError).code).toBe('CONFLICT');
  });

  it('R21: leaves the Reviews list, with nothing held for the run, once the run fails', async () => {
    const harness = await start({ replies: { editor: () => 'Published' } });
    const { runId, review } = await atReview(harness);
    expect(reviewsOf(harness).map((entry) => entry.id)).toEqual([review.id]);

    await harness.bureau.reviews.resolve({
      id: review.id,
      decision: 'reject',
      principal: 'person:test',
      reason: 'Wrong release',
    });
    await waitUntil(async () => (await statusOf(harness, runId)) === 'failed');

    expect(reviewsOf(harness)).toEqual([]);
    expect(await harness.bureau.reviews.pendingOf(runId)).toEqual([]);
  });
});

describe('errorCodeOf', () => {
  it('reads the code from the class the run failed with, never from a message', () => {
    expect(
      errorCodeOf('WorkflowDocumentReviewRejectedError: review-rejected\n    at run (x.ts:1:1)'),
    ).toBe('review-rejected');
    expect(errorCodeOf('WorkflowDocumentSchemaError: input-invalid: nope')).toBe('input-invalid');
    expect(errorCodeOf('WorkflowDocumentSchemaError: output-invalid: nope')).toBe('output-invalid');
    expect(errorCodeOf('Error: review-rejected')).toBeNull();
    expect(errorCodeOf('Error: input-invalid: forged')).toBeNull();
    expect(errorCodeOf(undefined)).toBeNull();
  });
});

describe('bureau.workflows.runs.list errorCode (COR-2238)', () => {
  it('returns only the rejected runs when asked for review-rejected', async () => {
    const harness = await start({
      replies: { editor: () => 'Published' },
      overrides: { id: 'workflow-rejection-wire', assets: { storage: createMemoryAssetStorage() } },
    });
    const rejected = await atReview(harness, 'rejected-flow');
    const approved = await atReview(harness, 'approved-flow');
    await harness.bureau.reviews.resolve({
      id: rejected.review.id,
      decision: 'reject',
      principal: 'person:test',
      reason: 'Not yet',
    });
    await harness.bureau.reviews.resolve({
      id: approved.review.id,
      decision: 'approve',
      principal: 'person:test',
      payload: {},
    });
    await waitUntil(async () => {
      const state = await stateOf(harness, rejected.runId);
      return state?.status === 'failed';
    });
    await waitUntil(async () => {
      const state = await stateOf(harness, approved.runId);
      return state?.status === 'completed';
    });

    const handler = createBureauHandler(harness.bureau, {
      authentication: {
        resolveApiKeyPrincipal: async (key: string) =>
          key === 'reader-key'
            ? principalFromApiKey({ subject: 'reader', scopes: ['bureau.workflows:read'] })
            : null,
        auditSink: () => undefined,
      },
    });
    const list = async (params: Record<string, unknown>) => {
      const response = await handler(
        new Request('http://localhost/jsonrpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-API-Key': 'reader-key' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'bureau.workflows.runs.list',
            params,
          }),
        }),
      );
      const body = (await response.json()) as {
        result?: { runs: { id: string }[] };
        error?: unknown;
      };
      expect(body.error).toBeUndefined();
      return body.result!.runs.map((run) => run.id);
    };

    expect(await list({})).toEqual(expect.arrayContaining([rejected.runId, approved.runId]));
    expect(await list({ errorCode: 'review-rejected' })).toEqual([rejected.runId]);
    expect(await list({ errorCode: 'review-rejected', status: 'completed' })).toEqual([]);
    expect(await list({ errorCode: 'something-else' })).toEqual([]);
  });
});
