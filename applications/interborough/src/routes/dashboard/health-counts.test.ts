import { describe, expect, test } from 'bun:test';

import {
  aggregateInputFor,
  FAILED_STATUSES,
  FAILED_WINDOW_MS,
  failedRecentlyFilter,
  WORKING_NOW_FILTER,
} from './health-counts.ts';

const NOON = Date.UTC(2026, 9, 31, 12, 0, 0);

describe('failedRecentlyFilter', () => {
  test('counts failed and timed-out runs that last changed within 24 hours', () => {
    expect(failedRecentlyFilter(NOON)).toEqual({
      status: [...FAILED_STATUSES],
      updatedAt: { gte: NOON - FAILED_WINDOW_MS },
    });
  });

  test('starts the window on a whole minute, so a count and its link name one instant', () => {
    const at = NOON + 59_999;
    expect(failedRecentlyFilter(at)).toEqual(failedRecentlyFilter(NOON));
    expect(failedRecentlyFilter(NOON + 60_000).updatedAt?.gte).toBe(
      NOON - FAILED_WINDOW_MS + 60_000,
    );
  });
});

describe('aggregateInputFor', () => {
  test('carries every field of the filters the page counts with, so a count and its link agree', () => {
    for (const filter of [WORKING_NOW_FILTER, failedRecentlyFilter(NOON)]) {
      const input: Record<string, unknown> = { ...aggregateInputFor(filter) };
      delete input['groupBy'];
      expect(Object.keys(input).toSorted()).toEqual(Object.keys(filter).toSorted());
    }
  });

  test('groups by status and carries only the filter fields the count uses', () => {
    expect(aggregateInputFor(WORKING_NOW_FILTER)).toEqual({ groupBy: 'status', status: 'running' });
    expect(aggregateInputFor(failedRecentlyFilter(NOON))).toEqual({
      groupBy: 'status',
      status: ['failed', 'timed-out'],
      updatedAt: { gte: NOON - FAILED_WINDOW_MS },
    });
    expect(aggregateInputFor({})).toEqual({ groupBy: 'status' });
  });
});
