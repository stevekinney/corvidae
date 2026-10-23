import { describe, expect, it } from 'bun:test';

import { FAILURE_BY_FINISH_REASON, isFailureFinishReason } from './finish-reason';
import type { FinishReason } from './types';

/** Every finish reason, so a reason added to the type has to be classified here too. */
const EXPECTED: Readonly<Record<FinishReason, boolean>> = {
  error: true,
  tripwire: true,
  'maximum-steps': true,
  'elicitation-denied': true,
  'budget-exceeded': true,
  'stop-condition': false,
  aborted: false,
};

describe('isFailureFinishReason (COR-1627)', () => {
  it('classifies every finish reason: five failures, a stop, and an abort', () => {
    expect(Object.keys(FAILURE_BY_FINISH_REASON).toSorted()).toEqual(
      Object.keys(EXPECTED).toSorted(),
    );
    for (const [finishReason, failure] of Object.entries(EXPECTED)) {
      expect([finishReason, isFailureFinishReason(finishReason)]).toEqual([finishReason, failure]);
    }
  });

  it('is false for anything that is not a known finish reason', () => {
    for (const value of [
      undefined,
      null,
      42,
      {},
      ['error'],
      '',
      'unknown',
      'toString',
      'constructor',
      '__proto__',
    ]) {
      expect(isFailureFinishReason(value)).toBe(false);
    }
  });
});
