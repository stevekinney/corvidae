import { describe, expect, test } from 'bun:test';

import { formatRunElapsed } from './composer-run-clock.ts';

describe('formatRunElapsed', () => {
  test('reads minutes and padded seconds under an hour', () => {
    expect(formatRunElapsed(0)).toBe('0:00');
    expect(formatRunElapsed(5_400)).toBe('0:05');
    expect(formatRunElapsed(83_000)).toBe('1:23');
    expect(formatRunElapsed(59 * 60_000 + 59_999)).toBe('59:59');
  });

  test('adds hours, with padded minutes, from an hour on', () => {
    expect(formatRunElapsed(3_600_000)).toBe('1:00:00');
    expect(formatRunElapsed(3_600_000 + 5 * 60_000 + 7_000)).toBe('1:05:07');
  });

  test('reads a negative or non-finite duration as no time at all', () => {
    expect(formatRunElapsed(-1_000)).toBe('0:00');
    expect(formatRunElapsed(Number.NaN)).toBe('0:00');
  });
});
