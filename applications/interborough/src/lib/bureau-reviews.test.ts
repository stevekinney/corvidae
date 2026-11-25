import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import type { Fetcher } from './bureau-client.ts';
import { humanWaitFixture, toolApprovalFixture } from './bureau-fixtures.test-support.ts';
import {
  getBureauReview,
  isReviewNoLongerWaiting,
  isReviewRoundChanged,
  listBureauReviews,
  listPendingReviews,
  pageReviews,
  resolveBureauReview,
  type BureauReview,
} from './bureau-reviews.ts';

const TOOL_APPROVAL = toolApprovalFixture();
const HUMAN_WAIT = humanWaitFixture();

type Call = { method: string; params: unknown };

function answering(result: unknown) {
  const calls: Call[] = [];
  const stub: Fetcher = async (_input, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Call;
    calls.push({ method: body.method, params: body.params });
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  };
  return { calls, fetch: stub };
}

async function withFetch<T>(stub: Fetcher, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(stub, { preconnect: original.preconnect });
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

describe('the Bureau’s review operations', () => {
  test('list parses tool approvals and human waits, a human wait with no session included', async () => {
    const stub = answering({ reviews: [TOOL_APPROVAL, HUMAN_WAIT] });
    const reviews = await withFetch(stub.fetch, () => listBureauReviews());
    expect(stub.calls).toEqual([{ method: 'bureau.reviews.list', params: {} }]);
    expect(reviews.map((review: BureauReview) => review.kind)).toEqual([
      'tool-approval',
      'human-wait',
    ]);
    const wait = reviews[1];
    expect(wait?.kind === 'human-wait' && wait.sessionId).toBeUndefined();
  });

  test('listPendingReviews reads every page of what waits, the engine’s reviews included', async () => {
    const engine = {
      source: 'engine',
      kind: 'engine-review',
      id: 'review-1',
      runId: 'wf-1',
      requestedAt: 1,
      ageMilliseconds: 1,
      status: 'pending',
      reviewType: 'Contract approval',
      reviewers: [],
      allowPartial: false,
    };
    const pages = [
      { reviews: [TOOL_APPROVAL], nextPageToken: 'next' },
      { reviews: [engine], nextPageToken: null },
    ];
    const calls: Call[] = [];
    const stub: Fetcher = async (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Call;
      calls.push({ method: body.method, params: body.params });
      return Response.json({ jsonrpc: '2.0', id: 1, result: pages[calls.length - 1] });
    };
    const reviews = await withFetch(stub, () => listPendingReviews());
    expect(calls.map((call) => call.params)).toEqual([
      { status: 'pending' },
      { status: 'pending', pageToken: 'next' },
    ]);
    expect(reviews.map((review) => review.kind)).toEqual(['tool-approval', 'engine-review']);
  });

  test('keeps an approval’s irreversible, consequence and why, and reads a review without them (COR-2438)', async () => {
    const explained = toolApprovalFixture({
      approval: {
        ...TOOL_APPROVAL.approval,
        action: {
          type: 'approval',
          message: 'Refund order-1001?',
          risk: 'high',
          operation: { kind: 'other' },
          irreversible: true,
          consequence: 'Sends $42.00 back to the card.',
          why: 'The order arrived damaged.',
        },
      },
    });
    const stub = answering({ reviews: [explained, TOOL_APPROVAL] });
    const [withFields, without] = await withFetch(stub.fetch, () => listBureauReviews());
    expect(withFields?.kind === 'tool-approval' && withFields.approval.action).toMatchObject({
      irreversible: true,
      consequence: 'Sends $42.00 back to the card.',
      why: 'The order arrived damaged.',
    });
    expect(without?.kind === 'tool-approval' && without.approval.action).toEqual(
      TOOL_APPROVAL.approval.action,
    );
  });

  test('get reads one review by its id', async () => {
    const stub = answering(HUMAN_WAIT);
    const review = await withFetch(stub.fetch, () => getBureauReview(HUMAN_WAIT.id));
    expect(stub.calls[0]).toEqual({ method: 'bureau.reviews.get', params: { id: HUMAN_WAIT.id } });
    expect(review.kind === 'human-wait' && review.prompt).toBe(HUMAN_WAIT.prompt);
  });

  test('resolve sends the id, the decision, and the reason only when there is one', async () => {
    const stub = answering({
      id: TOOL_APPROVAL.id,
      kind: 'tool-approval',
      decision: 'approve',
      receipt: 'applied',
    });
    await withFetch(stub.fetch, () =>
      resolveBureauReview({ id: TOOL_APPROVAL.id, decision: 'approve' }),
    );
    await withFetch(stub.fetch, () =>
      resolveBureauReview({ id: TOOL_APPROVAL.id, decision: 'reject', reason: 'Wrong order' }),
    );
    expect(stub.calls).toEqual([
      { method: 'bureau.reviews.resolve', params: { id: TOOL_APPROVAL.id, decision: 'approve' } },
      {
        method: 'bureau.reviews.resolve',
        params: { id: TOOL_APPROVAL.id, decision: 'reject', reason: 'Wrong order' },
      },
    ]);
  });

  test('resolve sends the round the caller was shown when it has one (COR-1714)', async () => {
    const stub = answering({
      id: TOOL_APPROVAL.id,
      kind: 'tool-approval',
      decision: 'approve',
      receipt: 'applied',
    });
    await withFetch(stub.fetch, () =>
      resolveBureauReview({ id: TOOL_APPROVAL.id, decision: 'approve', round: 2 }),
    );
    expect(stub.calls[0]?.params).toEqual({ id: TOOL_APPROVAL.id, decision: 'approve', round: 2 });
  });

  test('tells a review that changed while it was read from every other Conflict', () => {
    const conflict = (reason: unknown) =>
      new HttpClientError(409, 'Conflict', { faultCode: 'Conflict', data: { reason } });
    const changed = conflict('REVIEW_ROUND_CHANGED');
    expect(isReviewRoundChanged(changed)).toBe(true);
    expect(isReviewRoundChanged(conflict('Another resolver won.'))).toBe(false);
    expect(isReviewRoundChanged(conflict('APPROVAL_OUTCOME_NOT_WRITTEN: x'))).toBe(false);
    expect(isReviewRoundChanged(new Error('REVIEW_ROUND_CHANGED: now at round 3'))).toBe(false);
  });

  test('tells a review that was already resolved, or is gone, from every other fault (COR-2426)', () => {
    const conflict = (reason: unknown) =>
      new HttpClientError(409, 'Conflict', { faultCode: 'Conflict', data: { reason } });
    expect(isReviewNoLongerWaiting(conflict('REVIEW_ALREADY_RESOLVED'))).toBe(true);
    // A NotFound also answers a caller who may not decide it, so it is not taken as gone.
    expect(isReviewNoLongerWaiting(new HttpClientError(404, 'No pending review'))).toBe(false);
    expect(isReviewNoLongerWaiting(conflict('REVIEW_ROUND_CHANGED: now at round 3'))).toBe(false);
    expect(isReviewNoLongerWaiting(conflict('Another resolver won.'))).toBe(false);
    expect(isReviewNoLongerWaiting(new Error('REVIEW_ALREADY_RESOLVED: x'))).toBe(false);
  });
});

describe('the merged review list (COR-1828)', () => {
  const ENGINE_REVIEW = {
    source: 'engine',
    kind: 'engine-review',
    id: 'review-1',
    runId: 'wf-1',
    requestedAt: 1_792_436_500_000,
    ageMilliseconds: 5,
    status: 'pending',
    reviewType: 'content',
    reviewers: ['alice'],
    allowPartial: false,
    artifact: { text: 'draft' },
  };

  test('a page carries the Bureau’s and the engine’s reviews, and the token to continue', async () => {
    const stub = answering({ reviews: [TOOL_APPROVAL, ENGINE_REVIEW], nextPageToken: 'next' });
    const page = await withFetch(stub.fetch, () =>
      pageReviews({ status: 'resolved', resolvedAfter: 5, limit: 2, pageToken: 'token' }),
    );
    expect(stub.calls).toEqual([
      {
        method: 'bureau.reviews.list',
        params: { status: 'resolved', resolvedAfter: 5, limit: 2, pageToken: 'token' },
      },
    ]);
    expect(page.reviews.map((review) => `${review.source}:${review.kind}`)).toEqual([
      'bureau:tool-approval',
      'engine:engine-review',
    ]);
    expect(page.nextPageToken).toBe('next');
  });

  test('a resolved review carries who decided it, and a secret answer only as a reference', async () => {
    const resolved = {
      ...HUMAN_WAIT,
      status: 'approved',
      resolution: {
        decision: 'approve',
        decidedBy: 'api-key:bob',
        decidedAt: 1_792_436_600_000,
        answerDigest: 'a'.repeat(64),
        secretRefs: ['human-wait:run-2:environment:0/password'],
      },
    };
    const stub = answering({ reviews: [resolved], nextPageToken: null });
    const page = await withFetch(stub.fetch, () => pageReviews({ status: 'resolved' }));
    const [review] = page.reviews;
    expect(review?.source === 'bureau' && review.resolution).toMatchObject({
      decision: 'approve',
      decidedBy: 'api-key:bob',
      secretRefs: ['human-wait:run-2:environment:0/password'],
    });
  });

  test('the inbox list follows every page and leaves the engine’s reviews to the Reviews screen', async () => {
    const calls: unknown[] = [];
    const stub: Fetcher = async (_input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Call;
      calls.push(body.params);
      const first = (body.params as { pageToken?: string }).pageToken === undefined;
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: first
          ? { reviews: [TOOL_APPROVAL, ENGINE_REVIEW], nextPageToken: 'second' }
          : { reviews: [HUMAN_WAIT], nextPageToken: null },
      });
    };
    const reviews = await withFetch(stub, () => listBureauReviews());
    expect(calls).toEqual([{}, { pageToken: 'second' }]);
    expect(reviews.map((review) => review.kind)).toEqual(['tool-approval', 'human-wait']);
  });

  test('resolve sends remember only when it is asked, and reads whether it was stored', async () => {
    const stub = answering({
      id: TOOL_APPROVAL.id,
      kind: 'tool-approval',
      decision: 'approve',
      receipt: 'applied',
      remembered: true,
    });
    const resolution = await withFetch(stub.fetch, () =>
      resolveBureauReview({ id: TOOL_APPROVAL.id, decision: 'approve', remember: true }),
    );
    expect(stub.calls[0]?.params).toEqual({
      id: TOOL_APPROVAL.id,
      decision: 'approve',
      remember: true,
    });
    expect(resolution.remembered).toBe(true);
  });
});
