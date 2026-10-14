import { describe, expect, test } from 'bun:test';

import { FAILURE_CLOSE_CODES } from '../protocol/failure-codes.ts';
import { isSendableCloseCode } from './close-codes.ts';

describe('isSendableCloseCode', () => {
  test('accepts every close code the failure table sends', () => {
    for (const [failure, code] of Object.entries(FAILURE_CLOSE_CODES)) {
      expect(isSendableCloseCode(code), failure).toBe(true);
    }
  });

  test.each([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1011, 1012, 1013, 1014, 3000, 4000, 4999])(
    'accepts %d',
    (code) => {
      expect(isSendableCloseCode(code)).toBe(true);
    },
  );

  test.each([
    -1,
    0,
    999,
    1004,
    1005,
    1006,
    1010,
    1015,
    1016,
    2999,
    5000,
    1002.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects %d', (code) => {
    expect(isSendableCloseCode(code)).toBe(false);
  });
});
