import { describe, expect, test } from 'bun:test';

import { restartRetryDelaySeconds } from './restart-retry-delay.ts';

describe('restartRetryDelaySeconds', () => {
  test('backs off 1, 2, 4, 8 seconds', () => {
    expect([1, 2, 3, 4].map(restartRetryDelaySeconds)).toEqual([1, 2, 4, 8]);
  });

  test('stays at 8 seconds for every later attempt', () => {
    expect([5, 6, 8, 20].map(restartRetryDelaySeconds)).toEqual([8, 8, 8, 8]);
  });

  test('treats a missing or odd attempt as the first', () => {
    expect(restartRetryDelaySeconds(0)).toBe(1);
    expect(restartRetryDelaySeconds(-3)).toBe(1);
    expect(restartRetryDelaySeconds(Number.NaN)).toBe(1);
    expect(restartRetryDelaySeconds(Number.POSITIVE_INFINITY)).toBe(1);
  });
});
