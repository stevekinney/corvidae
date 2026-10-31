/**
 * What `/reviews` lists from the merged review list (`review-items.ts`): which reviews wait and
 * which are done, the key each is selected by, the review that follows one, and how a review reads
 * in a row.
 */
import { describe, expect, test } from 'bun:test';

import { REVIEWS_COPY } from '../../app/copy.ts';
import { humanWaitFixture, toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import type { EngineReview, ListedReview } from '../../lib/bureau-reviews.ts';
import {
  doneItems,
  inboxKey,
  neighbourKey,
  resolutionLabel,
  reviewKindLabel,
  reviewTitle,
  waitingItems,
} from './review-items.ts';

const engine = (overrides: Partial<EngineReview> = {}): EngineReview => ({
  source: 'engine',
  kind: 'engine-review',
  id: 'review-1',
  runId: 'wf-1',
  requestedAt: 5,
  ageMilliseconds: 1,
  status: 'pending',
  reviewType: 'Contract approval',
  reviewers: [],
  allowPartial: false,
  ...overrides,
});

const decided = (overrides: Parameters<typeof toolApprovalFixture>[0] = {}): ListedReview =>
  toolApprovalFixture({
    status: 'approved',
    resolution: { decision: 'approve', decidedBy: 'steve', decidedAt: 9 },
    ...overrides,
  });

describe('the key of a review', () => {
  test('names its source, so a Bureau review and an engine review of one identifier differ', () => {
    expect(inboxKey(engine({ id: 'x' }))).toBe('engine:x');
    expect(inboxKey(toolApprovalFixture({ id: 'x' }))).toBe('bureau:x');
  });
});

describe('what waits', () => {
  test('is the pending reviews, in the order the list gave them', () => {
    const reviews = [toolApprovalFixture({ id: 'b' }), decided({ id: 'c' }), engine({ id: 'a' })];
    expect(waitingItems(reviews).map((item) => item.key)).toEqual(['bureau:b', 'engine:a']);
  });

  test('lists a review once, even when the list repeats it', () => {
    const review = toolApprovalFixture({ id: 'b' });
    expect(waitingItems([review, review])).toHaveLength(1);
  });
});

describe('what is done', () => {
  test('is every decided review given, in the order given, and no pending one', () => {
    const items = doneItems([
      decided({ id: 'a' }),
      toolApprovalFixture({ id: 'p' }),
      decided({ id: 'b' }),
    ]);
    expect(items.map((item) => item.key)).toEqual(['bureau:a', 'bureau:b']);
  });
});

describe('the review that follows one', () => {
  const items = waitingItems([
    toolApprovalFixture({ id: 'a' }),
    toolApprovalFixture({ id: 'b' }),
    toolApprovalFixture({ id: 'c' }),
  ]);

  test('is the next one, or the one before when it is last', () => {
    expect(neighbourKey(items, 'bureau:a')).toBe('bureau:b');
    expect(neighbourKey(items, 'bureau:b')).toBe('bureau:c');
    expect(neighbourKey(items, 'bureau:c')).toBe('bureau:b');
  });

  test('is none for a review that is alone or not in the list', () => {
    expect(neighbourKey(items.slice(0, 1), 'bureau:a')).toBeNull();
    expect(neighbourKey(items, 'bureau:zzz')).toBeNull();
  });
});

describe('how a review reads in a row', () => {
  test('is the approval’s question, the question’s prompt, or the type of workflow review', () => {
    expect(reviewTitle(toolApprovalFixture())).toBe('Refund order-1001?');
    expect(reviewTitle(humanWaitFixture({ prompt: 'Which one?' }))).toBe('Which one?');
    expect(reviewTitle(humanWaitFixture({ prompt: undefined }))).toBe(
      REVIEWS_COPY.questionFallback,
    );
    expect(reviewTitle(engine())).toBe('Contract approval');
  });

  test('says which kind of review it is', () => {
    expect(reviewKindLabel(toolApprovalFixture())).toBe(REVIEWS_COPY.toolApproval);
    expect(reviewKindLabel(humanWaitFixture())).toBe(REVIEWS_COPY.humanWait);
    expect(reviewKindLabel(engine())).toBe(REVIEWS_COPY.workflowReview);
  });
});

describe('what became of a review, in a word', () => {
  test('is approved, denied or rejected for a tool, and answered for a question', () => {
    expect(resolutionLabel(decided())).toBe('Approved');
    expect(resolutionLabel(decided({ status: 'denied' }))).toBe('Denied');
    expect(resolutionLabel(decided({ status: 'rejected' }))).toBe('Rejected');
    expect(resolutionLabel(humanWaitFixture({ status: 'approved' }))).toBe('Answered');
  });

  test('is closed for a review the Bureau closed itself, and waiting while it waits', () => {
    expect(resolutionLabel(decided({ status: 'expired' }))).toBe('Closed');
    expect(resolutionLabel(humanWaitFixture({ status: 'canceled' }))).toBe('Closed');
    expect(resolutionLabel(toolApprovalFixture())).toBe('Waiting');
  });

  test('keeps the engine’s own words for a workflow review', () => {
    const review = (decision: 'approved' | 'rejected' | 'needs-changes') =>
      engine({
        status: 'completed',
        resolution: { decision, decidedBy: 'ops', decidedAt: 9 },
      });
    expect(resolutionLabel(review('approved'))).toBe('Approved');
    expect(resolutionLabel(review('rejected'))).toBe('Rejected');
    expect(resolutionLabel(review('needs-changes'))).toBe('Changes requested');
    expect(resolutionLabel(engine({ status: 'completed' }))).toBe('Closed');
  });
});
