import { describe, expect, it } from 'bun:test';

import {
  bureauReviewsOf,
  describeResolution,
  describeStatus,
  isOutcomeNotWritten,
  isReview,
  isReviewList,
  isRoundChanged,
  MAXIMUM_PAGES,
  readPendingQueue,
  type Review,
  type ReviewPage,
  viewReview,
} from './model.ts';

const approval: Review = {
  id: 'r1',
  runId: 'run-1',
  kind: 'tool-approval',
  status: 'pending',
  agentName: 'worker',
  requestedAt: 0,
  round: 0,
  approval: {
    toolName: 'shell',
    arguments: { cmd: 'rm -rf build' },
    reason: 'writes outside the sandbox',
    action: {
      type: 'approval',
      risk: 'high',
      expiresAt: '2026-01-01T00:10:00.000Z',
      operation: { kind: 'command', command: 'rm -rf build' },
    },
  },
};

describe('the pending-review model', () => {
  it('recognizes the list and one review, and refuses anything else', () => {
    expect(isReviewList({ reviews: [approval] })).toBe(true);
    expect(isReviewList({ reviews: [{ id: 1 }] })).toBe(false);
    expect(isReviewList(null)).toBe(false);
    expect(isReview(approval)).toBe(true);
    expect(isReview({ reviews: [] })).toBe(false);
  });

  it('accepts a list that carries a workflow review of the engine, and keeps only the Bureau’s own', () => {
    const engine = { id: 'engine-1', kind: 'engine-review', source: 'engine', status: 'pending' };
    const page = { reviews: [engine, approval], nextPageToken: null };

    expect(isReviewList(page)).toBe(true);
    expect(isReviewList({ reviews: [{ id: 'x', kind: 'something-else' }] })).toBe(false);
    expect(isReviewList({ reviews: [], nextPageToken: 7 })).toBe(false);
    expect(isReview(engine)).toBe(false);
    expect(bureauReviewsOf(page as ReviewPage).map((review) => review.id)).toEqual([approval.id]);
  });

  it('follows the pages of the queue and drops the engine reviews between them', async () => {
    const second = { ...approval, id: 'approval:run-2:call-2' };
    const pages = new Map<string | undefined, ReviewPage>([
      [
        undefined,
        { reviews: [approval, { id: 'engine-1', kind: 'engine-review' }], nextPageToken: 'p2' },
      ],
      ['p2', { reviews: [second], nextPageToken: null }],
    ]);
    const asked: Array<string | undefined> = [];

    const queue = await readPendingQueue(async (token) => {
      asked.push(token);
      return pages.get(token);
    });

    expect(asked).toEqual([undefined, 'p2']);
    expect(queue).toEqual({ reviews: [approval, second], truncated: false });
  });

  it('fails the whole read when a page cannot be read, and stops at the page bound', async () => {
    expect(
      await readPendingQueue(async (token) =>
        token === undefined ? { reviews: [approval], nextPageToken: 'p2' } : undefined,
      ),
    ).toBeUndefined();

    let reads = 0;
    const endless = await readPendingQueue(async () => {
      reads += 1;
      return {
        reviews: [{ ...approval, id: `approval:run-${reads}:call` }],
        nextPageToken: `p${reads}`,
      };
    });

    expect(reads).toBe(MAXIMUM_PAGES);
    expect(endless?.truncated).toBe(true);
    expect(endless?.reviews).toHaveLength(MAXIMUM_PAGES);
  });

  it('shows what a reviewer decides on and offers a decision while it is pending', () => {
    const view = viewReview(approval, Date.parse('2026-01-01T00:00:00Z'));
    expect(view.title).toBe('worker asks to run shell');
    expect(view.detail).toContain('Risk: high');
    expect(view.detail).toContain('Command: rm -rf build');
    expect(view.decidable).toBe(true);
    expect(view.expired).toBe(false);
  });

  it('offers no decision once the approval expired, or the review is not pending', () => {
    const later = Date.parse('2026-01-01T00:10:00Z');
    expect(viewReview(approval, later)).toMatchObject({ expired: true, decidable: false });
    expect(viewReview({ ...approval, status: 'canceled' }, 0).decidable).toBe(false);
    expect(viewReview({ ...approval, status: 'superseded' }, 0).decidable).toBe(false);
  });

  it('truncates a long argument preview and tolerates a human wait', () => {
    const long = viewReview(
      { ...approval, approval: { toolName: 'x', arguments: { a: 'y'.repeat(1000) } } },
      0,
    );
    expect(long.detail.at(-1)).toContain('(truncated)');
    const wait = viewReview(
      {
        id: 'w',
        runId: 'r',
        kind: 'human-wait',
        status: 'pending',
        requestedAt: 0,
        signalName: 'go',
        prompt: 'Proceed?',
      },
      0,
    );
    expect(wait.title).toBe('agent is waiting for go');
    expect(wait.detail).toContain('Proceed?');
  });

  it('shows every path and the whole patch before a decision', () => {
    const patch = viewReview(
      {
        ...approval,
        approval: {
          toolName: 'apply_patch',
          arguments: {},
          action: {
            type: 'approval',
            risk: 'high',
            operation: {
              kind: 'patch',
              diff: `--- a\n+++ b\n${'+line\n'.repeat(500)}`,
              filesTouched: ['a.ts', 'b.ts'],
            },
          },
        },
      },
      0,
    );
    expect(patch.detail).toContain('Files: a.ts, b.ts');
    expect(patch.detail.find((line) => line.startsWith('Patch:'))).toHaveLength(
      'Patch:\n'.length + `--- a\n+++ b\n${'+line\n'.repeat(500)}`.length,
    );
  });

  it('never offers a decision on a human wait, which needs an answer', () => {
    const wait = viewReview(
      { id: 'w', runId: 'r', kind: 'human-wait', status: 'pending', requestedAt: 0 },
      0,
    );
    expect(wait.decidable).toBe(false);
  });

  it('recognizes a decision that took effect but whose outcome was not written', () => {
    expect(
      isOutcomeNotWritten({
        isError: true,
        content: [{ type: 'text', text: 'Conflict: APPROVAL_OUTCOME_NOT_WRITTEN: x' }],
      }),
    ).toBe(true);
    expect(
      isOutcomeNotWritten({ isError: true, content: [{ type: 'text', text: 'NotFound' }] }),
    ).toBe(false);
  });

  it('recognizes a decision refused because the review moved to another round', () => {
    expect(
      isRoundChanged({
        isError: true,
        content: [{ type: 'text', text: 'Conflict: REVIEW_ROUND_CHANGED: now at round 1' }],
      }),
    ).toBe(true);
    expect(
      isRoundChanged({ isError: true, content: [{ type: 'text', text: 'Conflict: lost' }] }),
    ).toBe(false);
  });

  it('words each outcome, and says a superseded decision did not resolve the review', () => {
    expect(describeResolution('approve', 'applied')).toBe('Approved.');
    expect(describeResolution('deny', 'applied')).toBe('Denied.');
    expect(describeResolution('reject', 'applied')).toBe('Rejected with feedback.');
    expect(describeResolution('approve', 'superseded')).toContain('still pending');
    expect(describeStatus('approved')).toBe('already approved');
    expect(describeStatus('expired')).toBe('expired');
    expect(describeStatus('mystery')).toBe('mystery');
  });
});
