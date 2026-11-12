/** The words the run page uses for its steps that depend on a count. */
import { describe, expect, test } from 'bun:test';

import { RUN_STEPS_COPY } from './copy/runs.ts';

describe('the count of a run’s steps', () => {
  test('says "1 step" for one step and "N steps" for any other number', () => {
    expect(RUN_STEPS_COPY.count(1, 1)).toBe('1 step');
    expect(RUN_STEPS_COPY.count(0, 0)).toBe('0 steps');
    expect(RUN_STEPS_COPY.count(2, 2)).toBe('2 steps');
  });

  test('says how many of the steps a filter shows', () => {
    expect(RUN_STEPS_COPY.count(1, 3)).toBe('1 of 3 steps');
  });
});
