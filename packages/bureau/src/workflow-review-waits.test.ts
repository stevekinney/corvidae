/**
 * COR-2009 — a workflow file's `await-signal` step written with `"review": true` (PageWorkflow,
 * "Overview", row 62g: "Wait for a person") creates a review: it lists in `bureau.reviews.list()`,
 * is read by `get`, and resolving it delivers the decision on the step's signal and resumes the
 * instance. A step without `review` is a signal wait, which the instance waits on and Reviews never
 * lists.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStorage } from '@lostgradient/storage';
import { principalFromApiKey } from '@lostgradient/weft';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { BureauError } from './create-bureau';
import { projectReview } from './http/bureau-reviews-operations';
import { createMemoryAssetStorage } from './assets/storage';
import { createBureauHandler } from './http/create-bureau-handler';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { AGENT_STEP } from './testing/workflow-file-fixtures.test-support';
import type { PendingHumanWaitReview } from './types';
import { workflowReviewId } from './workflow-review-waits';

describe('workflowReviewId', () => {
  it('keeps flat ids and distinguishes encoded iteration addresses', () => {
    expect(workflowReviewId('run', 'approve', 2)).toBe('human-wait:run:approve:2');
    expect(workflowReviewId('run', 'approve', 2, '2#summaries.0')).not.toBe(
      workflowReviewId('run', 'approve', 2, '2#summaries.1'),
    );
    expect(workflowReviewId('run', 'approve', 2, '2#a%2Eb')).not.toBe(
      workflowReviewId('run', 'approve', 2, '2#a.b'),
    );
  });
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A release workflow: a signal wait, a draft, then a person reviews the draft, then it is published. */
const RELEASE_NOTES = {
  title: 'Release notes',
  trigger: { kind: 'manual' },
  steps: [
    { title: 'Wait for the freeze', kind: 'await-signal', signal: 'freeze' },
    {
      title: 'Draft the notes',
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'writer', message: 'Draft the notes' },
    },
    { title: 'Approve the notes', kind: 'await-signal', signal: 'notes-approved', review: true },
    {
      title: 'Publish the notes',
      kind: 'activity',
      handler: 'agent',
      input: { agent: 'editor', message: 'Publish the notes' },
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

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function workflowReviews(harness: WorkflowBureauHarness): PendingHumanWaitReview[] {
  return harness.bureau.reviews
    .list()
    .filter(
      (review): review is PendingHumanWaitReview =>
        review.kind === 'human-wait' && review.workflow !== undefined,
    );
}

/** Whether instance `runId` is waiting for `signal`. */
async function waitsFor(
  harness: WorkflowBureauHarness,
  runId: string,
  signal: string,
): Promise<boolean> {
  const state = await harness.bureau.durableEngine()!.get(runId);
  return (state?.waitingForSignals ?? []).includes(signal);
}

/** The audit entries that record a decision on a review of instance `runId`. */
async function decisionAudit(harness: WorkflowBureauHarness, runId: string) {
  const records = await harness.bureau.internals.auditTrail!.query({ runId });
  return records.filter((record) => /^review\.human-wait\.(approved|denied)$/u.test(record.type));
}

async function statusOf(harness: WorkflowBureauHarness, runId: string): Promise<string> {
  const state = await harness.bureau.durableEngine()!.get(runId);
  return state?.status ?? 'missing';
}

/** Start Release notes and bring it to its review step. */
async function atReview(harness: WorkflowBureauHarness): Promise<{
  readonly runId: string;
  readonly review: PendingHumanWaitReview;
}> {
  await harness.putWorkflow('release-notes', RELEASE_NOTES);
  const { runId } = await harness.bureau.workflows!.start('release-notes', {
    owner: 'person:test',
  });
  const engine = harness.bureau.durableEngine()!;
  await waitUntil(() => waitsFor(harness, runId, 'freeze'));
  // A signal wait is not a review.
  expect(workflowReviews(harness)).toEqual([]);
  expect(await harness.bureau.reviews.pendingOf(runId)).toEqual([]);
  await engine.signal(runId, 'freeze', null);
  await waitUntil(() => workflowReviews(harness).length === 1);
  return { runId, review: workflowReviews(harness)[0]! };
}

describe('a workflow review step', () => {
  it('tells a review step from a signal wait on the same signal by the step the instance is at', async () => {
    const harness = await start();
    await harness.putWorkflow('twice', {
      trigger: { kind: 'manual' },
      steps: [
        { title: 'Wait for go', kind: 'await-signal', signal: 'go' },
        { title: 'Draft', ...AGENT_STEP },
        { title: 'Check the draft', kind: 'await-signal', signal: 'go', review: true },
      ],
    });
    const { runId } = await harness.bureau.workflows!.start('twice', { owner: 'person:test' });
    const engine = harness.bureau.durableEngine()!;
    await waitUntil(() => waitsFor(harness, runId, 'go'));
    expect(await harness.bureau.reviews.pendingOf(runId)).toEqual([]);

    await engine.signal(runId, 'go', null);

    await waitUntil(() => workflowReviews(harness).length === 1);
    expect(workflowReviews(harness)[0]).toMatchObject({
      id: `human-wait:${runId}:go:2`,
      prompt: 'Check the draft',
      workflow: { id: 'twice', step: 3 },
    });
  });

  it('leaves Reviews when its signal arrives some other way', async () => {
    const harness = await start();
    const { runId } = await atReview(harness);

    await harness.bureau.durableEngine()!.signal(runId, 'notes-approved', { note: 'by hand' });

    await waitUntil(() => workflowReviews(harness).length === 0);
    await waitUntil(async () => (await statusOf(harness, runId)) === 'completed');
    expect(await harness.bureau.reviews.pendingOf(runId)).toEqual([]);
  });

  it('lists in Reviews as a question waiting on you, named by its workflow and step', async () => {
    const harness = await start();
    const requested: string[] = [];
    harness.bureau.addEventListener('review.requested', (event) => {
      requested.push(event.reviewId);
    });

    const { runId, review } = await atReview(harness);

    expect(review).toMatchObject({
      kind: 'human-wait',
      id: `human-wait:${runId}:notes-approved:2`,
      runId,
      signalName: 'notes-approved',
      prompt: 'Approve the notes',
      workflow: {
        id: 'release-notes',
        title: 'Release notes',
        step: 3,
        stepTitle: 'Approve the notes',
      },
      status: 'pending',
    });
    expect(review.sessionId).toBeUndefined();
    expect(review.agentName).toBeUndefined();
    expect(await harness.bureau.reviews.get(review.id)).toMatchObject({
      id: review.id,
      workflow: { id: 'release-notes', step: 3 },
    });
    expect(await harness.bureau.reviews.pendingOf(runId)).toEqual([
      expect.objectContaining({ id: review.id }),
    ]);
    await waitUntil(() => requested.length > 0);
    expect(requested).toEqual([review.id]);
    // The wire carries the step that asks.
    expect(projectReview(review)).toMatchObject({
      kind: 'human-wait',
      workflow: {
        id: 'release-notes',
        title: 'Release notes',
        step: 3,
        stepTitle: 'Approve the notes',
      },
    });
  });

  it('resumes the instance with the answer when approved, and refuses a second resolve', async () => {
    const harness = await start({ replies: { writer: () => 'Release 2.4' } });
    const { runId, review } = await atReview(harness);

    const result = await harness.bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'person:test',
      payload: { note: 'Ship it' },
    });

    expect(result).toEqual({ id: review.id, kind: 'human-wait', decision: 'approve' });
    expect(workflowReviews(harness)).toEqual([]);
    await waitUntil(async () => (await statusOf(harness, runId)) === 'completed');
    // The step after the review was handed the answer.
    expect(harness.calls.at(-1)).toMatchObject({ agent: 'editor' });
    expect(harness.calls.at(-1)?.message).toContain('"note": "Ship it"');
    expect(harness.calls.at(-1)?.message).toContain('"content": "Release 2.4"');
    expect(await harness.bureau.reviews.get(review.id)).toMatchObject({
      id: review.id,
      status: 'approved',
      resolvedBy: 'person:test',
      workflow: { id: 'release-notes', step: 3 },
    });

    const again = await rejectionOf(
      harness.bureau.reviews.resolve({
        id: review.id,
        decision: 'approve',
        principal: 'person:test',
        payload: { note: 'Ship it' },
      }),
    );
    expect((again as BureauError).code).toBe('NOT_FOUND');
    // The decision is audited once: the refused second resolve writes no second entry.
    expect(await decisionAudit(harness, runId)).toEqual([
      expect.objectContaining({ runId, type: 'review.human-wait.approved' }),
    ]);
  });

  it('delivers a denial with its reason, which the next step reads as what to change', async () => {
    const harness = await start();
    const { runId, review } = await atReview(harness);

    await harness.bureau.reviews.resolve({
      id: review.id,
      decision: 'deny',
      principal: 'person:test',
      reason: 'Mention the refund change',
    });

    expect(workflowReviews(harness)).toEqual([]);
    await waitUntil(async () => (await statusOf(harness, runId)) === 'completed');
    const handed = harness.calls.at(-1)?.message ?? '';
    expect(handed).toContain('"__abDenied": true');
    expect(handed).toContain('"reason": "Mention the refund change"');
    expect(await harness.bureau.reviews.get(review.id)).toMatchObject({
      status: 'denied',
      resolvedBy: 'person:test',
      resolutionReason: 'Mention the refund change',
    });
    // The same decision again is the documented NOT_FOUND of a resolved review; a different one
    // is refused as a conflict with the decision made.
    const same = await rejectionOf(
      harness.bureau.reviews.resolve({
        id: review.id,
        decision: 'deny',
        principal: 'person:test',
        reason: 'Mention the refund change',
      }),
    );
    expect((same as BureauError).code).toBe('NOT_FOUND');
    const different = await rejectionOf(
      harness.bureau.reviews.resolve({
        id: review.id,
        decision: 'approve',
        principal: 'person:test',
        payload: {},
      }),
    );
    expect((different as BureauError).code).toBe('CONFLICT');
    expect(await decisionAudit(harness, runId)).toEqual([
      expect.objectContaining({ runId, type: 'review.human-wait.denied' }),
    ]);
  });

  it('reaches the Reviews page over the wire, which lists, reads and resolves it', async () => {
    const harness = await start({
      overrides: { id: 'workflow-review-wire', assets: { storage: createMemoryAssetStorage() } },
    });
    const { runId, review } = await atReview(harness);
    const handler = createBureauHandler(harness.bureau, {
      authentication: {
        resolveApiKeyPrincipal: async (key: string) =>
          key === 'reviewer-key'
            ? principalFromApiKey({
                subject: 'reviewer',
                scopes: ['bureau.reviews:read', 'bureau.reviews:resolve'],
              })
            : null,
        auditSink: () => undefined,
      },
    });
    const call = async (method: string, params: unknown) => {
      const response = await handler(
        new Request('http://localhost/jsonrpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-API-Key': 'reviewer-key' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
      );
      return (await response.json()) as { result?: Record<string, unknown> };
    };

    const listed = await call('bureau.reviews.list', {});
    expect(listed.result?.['reviews']).toEqual([
      expect.objectContaining({
        source: 'bureau',
        kind: 'human-wait',
        id: review.id,
        runId,
        status: 'pending',
        workflow: {
          id: 'release-notes',
          title: 'Release notes',
          step: 3,
          stepTitle: 'Approve the notes',
        },
      }),
    ]);
    const fetched = await call('bureau.reviews.get', { id: review.id });
    expect(fetched.result).toMatchObject({ id: review.id, workflow: { step: 3 } });
    const resolved = await call('bureau.reviews.resolve', {
      id: review.id,
      decision: 'approve',
      answer: { note: 'Ship it' },
    });
    expect(resolved.result).toMatchObject({
      id: review.id,
      decision: 'approve',
      receipt: 'applied',
    });
    await waitUntil(async () => (await statusOf(harness, runId)) === 'completed');
  });

  it('is still waiting after a restart, on the version its instance began on', async () => {
    const storage = new MemoryStorage();
    const directory = await mkdtemp(join(tmpdir(), 'bureau-workflow-review-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const first = await start({ directory, overrides: { storage } });
    const { runId, review } = await atReview(first);
    // The file moves on without the review step; the instance stays on the version it began on,
    // whose saved steps still say the step it waits at is a review.
    await first.putWorkflow('release-notes', {
      ...RELEASE_NOTES,
      steps: RELEASE_NOTES.steps.filter((step) => step.kind !== 'await-signal'),
    });
    await first.bureau.dispose();

    const second = await start({ directory, overrides: { storage } });

    expect(workflowReviews(second)).toEqual([
      expect.objectContaining({ id: review.id, runId, requestedAt: review.requestedAt }),
    ]);
    await second.bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'person:test',
      payload: { note: 'Ship it' },
    });
    await waitUntil(async () => (await statusOf(second, runId)) === 'completed');
  });
});
