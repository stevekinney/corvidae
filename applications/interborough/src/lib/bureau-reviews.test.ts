import { describe, expect, test } from 'bun:test';

import type { Fetcher } from './bureau-client.ts';
import { humanWaitFixture, toolApprovalFixture } from './bureau-fixtures.test-support.ts';
import {
  getBureauReview,
  listBureauReviews,
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

  test('a review of a kind the Bureau does not define is a fault, not a row', async () => {
    const stub = answering({ reviews: [{ ...HUMAN_WAIT, kind: 'mystery' }] });
    await expect(withFetch(stub.fetch, () => listBureauReviews())).rejects.toThrow();
  });
});
