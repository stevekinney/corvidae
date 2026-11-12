import { describe, expect, test } from 'bun:test';

import { formatCountdown } from './format-countdown.ts';

describe('formatCountdown', () => {
  test('reads whole seconds the way Cinder reads durations, with a zero of its own', () => {
    expect(formatCountdown(8)).toBe('8s');
    expect(formatCountdown(5)).toBe('5s');
    expect(formatCountdown(0)).toBe('0s');
    expect(formatCountdown(-3)).toBe('0s');
    expect(formatCountdown(65)).toBe('1m 5s');
  });
});
