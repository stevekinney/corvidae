import { describe, expect, test } from 'bun:test';

import { closeCodeForFailure, FAILURE_CLOSE_CODES, type FailureCode } from './failure-codes.ts';

describe('failure codes', () => {
  test('map each code to the close code in the failure table', () => {
    const expected: Record<FailureCode, number> = {
      'protocol-version-unsupported': 1002,
      'malformed-frame': 1002,
      'frame-too-large': 1009,
      'stale-generation': 1008,
      'read-only': 1008,
      'fifo-full': 1013,
      'unsupported-runtime': 1011,
      'spawn-failed': 1011,
      'backend-failed': 1011,
      'transport-failed': 1011,
      'cleanup-incomplete': 1000,
    };
    for (const [code, closeCode] of Object.entries(expected)) {
      expect(closeCodeForFailure(code as FailureCode), code).toBe(closeCode);
    }
    expect(Object.keys(FAILURE_CLOSE_CODES).toSorted()).toEqual(Object.keys(expected).toSorted());
  });

  test('never send the reserved abnormal-closure code', () => {
    expect(Object.values(FAILURE_CLOSE_CODES)).not.toContain(1006);
  });
});
