/**
 * The related runs of a run a goal or a schedule started (COR-2424, rows 55h and 55m): the goal's
 * other attempts with how their check went, and a schedule's run saying whether it was the
 * schedule's last and how many occurrences have been missed since.
 */
import { describe, expect, test } from 'bun:test';

import { goalAttemptFixture, goalFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { otherAttempts, scheduleRelatedSentence } from './run-related-lines.ts';

const GOAL = goalFixture('summarize-open-refunds', {
  bounds: {
    maximumAttempts: 5,
    maximumTotalDurationMs: null,
    maximumTotalSteps: null,
    maximumTotalTokens: null,
    maximumTotalCostUsd: null,
  },
  attempts: [
    goalAttemptFixture('run-5d19b3', { attemptIndex: 1, status: 'aborted' }),
    goalAttemptFixture('run-1', { attemptIndex: 0, status: 'failed' }),
    goalAttemptFixture('run-3', { attemptIndex: 2, status: 'passed' }),
  ],
});

describe('the other attempts of a goal', () => {
  test('are said as "Attempt 1 of 5 (Check not met)", in the order they were made, without this run (row 55h)', () => {
    expect(otherAttempts(GOAL, 'run-5d19b3')).toEqual([
      { runId: 'run-1', label: 'Attempt 1 of 5 (Check not met)' },
      { runId: 'run-3', label: 'Attempt 3 of 5 (Check met)' },
    ]);
  });

  test('are none for a goal whose only attempt is this run', () => {
    const only = goalFixture('say-hello', {
      attempts: [goalAttemptFixture('run-only', { attemptIndex: 0 })],
    });
    expect(otherAttempts(only, 'run-only')).toEqual([]);
  });
});

describe('a schedule’s run', () => {
  const started = Date.parse('2026-10-29T04:00:00.000Z');
  const last = { lastFireAt: '2026-10-29T04:00:00.500Z' };

  test('says it was the schedule’s last run and how many occurrences it has missed since (row 55m)', () => {
    expect(scheduleRelatedSentence(last, started, 4)).toBe(
      'This was the schedule’s last run. It has missed 4 occurrences since.',
    );
    expect(scheduleRelatedSentence(last, started, 1)).toBe(
      'This was the schedule’s last run. It has missed 1 occurrence since.',
    );
  });

  test('leaves the missed count out when the Bureau lists none missed since', () => {
    expect(scheduleRelatedSentence(last, started, undefined)).toBe(
      'This was the schedule’s last run.',
    );
    expect(scheduleRelatedSentence(last, started, 0)).toBe('This was the schedule’s last run.');
  });

  test('says the schedule has run since when it fired after this run, and nothing when it never fired', () => {
    expect(scheduleRelatedSentence({ lastFireAt: '2026-10-30T04:00:00.000Z' }, started, 3)).toBe(
      'The schedule has run since.',
    );
    expect(scheduleRelatedSentence({ lastFireAt: null }, started, 3)).toBeUndefined();
  });
});
