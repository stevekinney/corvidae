/**
 * COR-2280 P7 (COR-2438 AC12, AC13, AC19): the deadlines the chat reads back from the Bureau's
 * reviews are fenced by generation and round, kept per run, and an expiry advances the displayed
 * clock with the observation it was clamped to.
 */
import { describe, expect, test } from 'bun:test';

import { toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import type { BureauToolApproval } from '../../lib/bureau-reviews.ts';
import {
  ApprovalReviewDeadlines,
  type ApprovalReviewCandidate,
} from './approval-review-deadlines.svelte.ts';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const LATER = '2026-11-17T12:30:00.000Z';

/** The approval row of `runId`'s call `call-1` at `round`. */
function row(runId: string, round: number): ApprovalReviewCandidate {
  return {
    callId: 'call-1',
    rawCallId: 'call-1',
    rowId: `${runId}:step:1:result:call-1`,
    reviewId: `approval:${runId}:call-1`,
    runId,
    key: `approval:${runId}:call-1:${runId}:step:1:result:call-1:round:${round}`,
  };
}

/** What `bureau.reviews.get` says of that review. */
function review(
  runId: string,
  status: 'pending' | 'expired',
  round: number,
  overrides: Partial<BureauToolApproval> = {},
): BureauToolApproval {
  const base = toolApprovalFixture({ id: `approval:${runId}:call-1`, runId, status, round });
  return {
    ...base,
    approval: {
      ...base.approval,
      callId: 'call-1',
      action: { type: 'approval', risk: 'high', operation: { kind: 'other' }, expiresAt: LATER },
    },
    ...overrides,
  };
}

describe('the review-read deadline cache (COR-2280 P7)', () => {
  test('drops a read that answers after a newer generation began', () => {
    const deadlines = new ApprovalReviewDeadlines();
    const candidate = row('run-1', 0);
    const first = deadlines.begin([candidate]);
    const second = deadlines.begin([candidate]);

    expect(deadlines.apply(candidate, review('run-1', 'pending', 0), first, NOW)).toBeUndefined();
    expect(deadlines.observed).toEqual({});

    expect(deadlines.apply(candidate, review('run-1', 'pending', 0), second, NOW)).toEqual({
      reconcile: { toolCallId: 'call-1', expiresAt: LATER },
    });
    expect(deadlines.observed[candidate.key]).toEqual({ expiresAt: LATER, round: 0 });
  });

  test('a late pending read of the terminal round cannot bring the deadline back; a newer round can', () => {
    const deadlines = new ApprovalReviewDeadlines();
    const candidate = row('run-1', 1);
    const generation = deadlines.begin([candidate]);
    const expired = review('run-1', 'expired', 1, {
      resolution: { decidedBy: 'system:expiry', decidedAt: NOW - 1_000 },
    });

    expect(deadlines.apply(candidate, expired, generation, NOW)?.reconcile.expiresAt).toBe(
      new Date(NOW - 1_000).toISOString(),
    );
    // The same round, pending, answering late: fenced off, the marker stands.
    expect(
      deadlines.apply(candidate, review('run-1', 'pending', 1), generation, NOW),
    ).toBeUndefined();
    expect(deadlines.expired[candidate.key]).toBe(new Date(NOW - 1_000).toISOString());
    // A strictly newer round is a renewed approval: the expiry clears and its deadline is read.
    expect(deadlines.apply(candidate, review('run-1', 'pending', 2), generation, NOW)).toEqual({
      reconcile: { toolCallId: 'call-1', expiresAt: LATER },
    });
    expect(deadlines.expired[candidate.key]).toBeUndefined();
  });

  test('an observed deadline is replaced only from the same or a newer round', () => {
    const deadlines = new ApprovalReviewDeadlines();
    const candidate = row('run-1', 3);
    const generation = deadlines.begin([candidate]);
    deadlines.apply(candidate, review('run-1', 'pending', 3), generation, NOW);

    const older = review('run-1', 'pending', 2);
    const olderAction = { ...older.approval.action, expiresAt: '2026-11-17T12:05:00.000Z' };
    expect(
      deadlines.apply(
        candidate,
        { ...older, approval: { ...older.approval, action: olderAction } },
        generation,
        NOW,
      ),
    ).toBeUndefined();
    expect(deadlines.observed[candidate.key]).toEqual({ expiresAt: LATER, round: 3 });
  });

  test('a row whose round moved keeps its expiry and its terminal round under the new key', () => {
    const deadlines = new ApprovalReviewDeadlines();
    const before = row('run-1', 1);
    const generation = deadlines.begin([before]);
    deadlines.apply(before, review('run-1', 'expired', 1), generation, NOW);

    const after = { ...before, key: before.key.replace(':round:1', ':round:unknown') };
    const next = deadlines.begin([after]);
    expect(deadlines.expired[after.key]).toBe(deadlines.expired[before.key]);
    // The terminal round moved with it, so a late pending read of round 1 stays fenced off.
    expect(deadlines.apply(after, review('run-1', 'pending', 1), next, NOW)).toBeUndefined();
  });

  test('two native runs whose custom rows share a call id keep their own deadlines', () => {
    const deadlines = new ApprovalReviewDeadlines();
    const first = row('run-1', 0);
    const second = row('run-2', 0);
    const generation = deadlines.begin([first, second]);

    deadlines.apply(first, review('run-1', 'expired', 0), generation, NOW);
    deadlines.apply(second, review('run-2', 'pending', 0), generation, NOW);
    // Another run's review never answers for this row.
    expect(deadlines.apply(first, review('run-2', 'pending', 5), generation, NOW)).toBeUndefined();

    expect(Object.keys(deadlines.expired)).toEqual([first.key]);
    expect(Object.keys(deadlines.observed)).toEqual([second.key]);
    expect(deadlines.observed[second.key]?.expiresAt).toBe(LATER);
  });

  test('an expiry hands back the clock it was clamped to, so the displayed clock is not stale', () => {
    const deadlines = new ApprovalReviewDeadlines();
    const candidate = row('run-1', 0);
    const generation = deadlines.begin([candidate]);
    // The Bureau's record is ahead of this clock: the marker is clamped to now, and the displayed
    // clock must reach it, or the rail would still read the approval as waiting.
    const ahead = review('run-1', 'expired', 0, {
      resolution: { decidedBy: 'system:expiry', decidedAt: NOW + 60_000 },
    });

    const outcome = deadlines.apply(candidate, ahead, generation, NOW);
    expect(outcome?.clockAt).toBe(NOW);
    expect(Date.parse(outcome!.reconcile.expiresAt)).toBeLessThanOrEqual(outcome!.clockAt!);
    expect(deadlines.expired[candidate.key]).toBe(new Date(NOW).toISOString());
    // A pending read moves no clock.
    const pending = new ApprovalReviewDeadlines();
    const pendingGeneration = pending.begin([candidate]);
    expect(
      pending.apply(candidate, review('run-1', 'pending', 0), pendingGeneration, NOW)?.clockAt,
    ).toBeUndefined();
  });

  test('the chat page applies the clock an expiry hands back to its displayed clock', async () => {
    // The page's rail and card read `bureauNow`; without this assignment the rail keeps the tick
    // from before the approval stopped being live, and reads it as waiting (the stale clock).
    const source = await Bun.file(new URL('./chat-conversation.svelte', import.meta.url)).text();
    const read = source.slice(source.indexOf('reviewDeadlines.apply('));
    const applied = read.slice(0, read.indexOf('reconcileApprovalExpiry'));
    expect(applied).toMatch(/if \(outcome\.clockAt !== undefined\) bureauNow = outcome\.clockAt;/);
  });

  test('claims a row’s read once until it is released', () => {
    const deadlines = new ApprovalReviewDeadlines();
    expect(deadlines.claim('key')).toBe(true);
    expect(deadlines.claim('key')).toBe(false);
    deadlines.release('key');
    expect(deadlines.claim('key')).toBe(true);
  });
});
