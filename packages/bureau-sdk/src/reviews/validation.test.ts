import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';
import { createReviewsClientWithTransport, parseReviewsOpeningSnapshot } from './client.ts';

const review = {
  source: 'bureau',
  kind: 'tool-approval',
  id: 'approval:1',
  runId: 'run:1',
  sessionId: 'session:1',
  requestedAt: 1,
  ageMilliseconds: 0,
  status: 'pending',
  round: 0,
  approval: { callId: 'call:1', toolName: 'send', arguments: {}, action: { type: 'input' } },
};
const list = { reviews: [review], total: 1, nextPageToken: null };
const receipt = { id: review.id, kind: 'tool-approval', decision: 'approve', receipt: 'applied' };

describe('the portable Reviews boundary', () => {
  it('omits unknown effects while rejecting malformed known effects', async () => {
    const unknown = { ...review, effect: { kind: 'inventory', publicId: 'one' } };
    const client = createReviewsClientWithTransport(async () => unknown);
    expect(await client['bureau.reviews.get']({ id: review.id })).toEqual(review);
    expect(parseReviewsOpeningSnapshot({ reviews: [unknown] })?.reviews[0]).toEqual(review);
    const malformed = createReviewsClientWithTransport(async () => ({
      ...review,
      effect: { kind: 'refund', refundId: 9 },
    }));
    expect(await rejectionOf(malformed['bureau.reviews.get']({ id: review.id }))).toMatchObject({
      message: 'Invalid bureau.reviews.get response',
    });
  });
  it('builds without dynamic code evaluation for a sandbox content security policy', async () => {
    const build = await Bun.build({
      entrypoints: [new URL('./client.ts', import.meta.url).pathname],
      target: 'browser',
      metafile: true,
    });
    expect(build.success).toBe(true);
    const inputs = Object.keys(build.metafile?.inputs ?? {});
    expect(inputs.some((path) => /(?:^|\/)svelte(?:\/|$)|\.svelte(?:\.ts)?$/u.test(path))).toBe(
      false,
    );
    expect(inputs.some((path) => /(?:^|\/)bureau\/src\//u.test(path))).toBe(false);
    const source = await build.outputs[0].text();
    expect(source).not.toMatch(/\b(?:eval|Function)\s*\(/u);
  });
  it('validates the declared list, detail and decision outputs', async () => {
    let value: unknown = list;
    const client = createReviewsClientWithTransport(async () => value);
    expect(await client['bureau.reviews.list']({})).toEqual(list);
    value = review;
    expect(await client['bureau.reviews.get']({ id: review.id })).toEqual(review);
    value = receipt;
    expect(
      await client['bureau.reviews.resolve']({ id: review.id, round: 0, decision: 'approve' }),
    ).toEqual(receipt);
    value = { ...list, reviews: [{ ...review, id: 9 }] };
    expect(await rejectionOf(client['bureau.reviews.list']({}))).toMatchObject({
      message: 'Invalid bureau.reviews.list response',
    });
    value = { ...review, round: '0' };
    expect(await rejectionOf(client['bureau.reviews.get']({ id: review.id }))).toMatchObject({
      message: 'Invalid bureau.reviews.get response',
    });
    value = { ...receipt, receipt: 1 };
    expect(
      await rejectionOf(
        client['bureau.reviews.resolve']({ id: review.id, round: 0, decision: 'approve' }),
      ),
    ).toMatchObject({ message: 'Invalid bureau.reviews.resolve response' });
  });

  it('accepts a display-only opening without fabricating a round and rejects private or malformed fields', () => {
    const { round: _round, ...withoutRound } = review;
    const snapshot = parseReviewsOpeningSnapshot({ reviews: [withoutRound] });
    expect(snapshot?.actionable).toBe(false);
    expect(snapshot?.reviews[0]).not.toHaveProperty('round');
    withoutRound.id = 'changed-after-parsing';
    expect(snapshot?.reviews[0]?.id).toBe('approval:1');
    expect(parseReviewsOpeningSnapshot({ reviews: [{ ...withoutRound, id: 9 }] })).toBeUndefined();
    expect(
      parseReviewsOpeningSnapshot({
        reviews: [{ ...withoutRound, approval: { ...review.approval, approvalToken: 'private' } }],
      }),
    ).toBeUndefined();
    expect(parseReviewsOpeningSnapshot(list)?.reviews[0]).toHaveProperty('round', 0);
  });
});
