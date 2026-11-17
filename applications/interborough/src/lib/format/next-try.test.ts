import { describe, expect, test } from 'bun:test';

import { NEXT_TRY_DUE, nextTryWords } from './next-try.ts';

const START = 1_760_000_000_000;

describe('nextTryWords', () => {
  test('says how long until the next try, in words', () => {
    expect(nextTryWords(START + 40_000, START)).toBe('40 seconds');
    expect(nextTryWords(START + 1_000, START)).toBe('1 second');
    expect(nextTryWords(START + 5 * 60_000, START)).toBe('5 minutes');
    expect(nextTryWords(START + 3 * 3_600_000, START)).toBe('3 hours');
    expect(nextTryWords(START + 90 * 60_000, START)).toBe('2 hours');
    expect(nextTryWords(START + 3_600_000, START)).toBe('60 minutes');
  });

  test('rounds a part of a second up, so a try is never said to be due before it is', () => {
    expect(nextTryWords(START + 1_001, START)).toBe('2 seconds');
  });

  test('says a moment for a try that is due or past due', () => {
    expect(nextTryWords(START, START)).toBe(NEXT_TRY_DUE);
    expect(nextTryWords(START - 5_000, START)).toBe(NEXT_TRY_DUE);
    expect(NEXT_TRY_DUE).toBe('a moment');
  });
});
