/**
 * The single `retryable` table: one boolean per fault code, and `true` only where the identical
 * call can succeed later with no change by the caller.
 */

import { describe, expect, it } from 'bun:test';

import { FAULT_CODE_RETRYABLE, FAULT_CODES, isFaultRetryable } from './fault-code.ts';

describe('FAULT_CODE_RETRYABLE', () => {
  it('holds exactly one boolean for every fault code, so a new code fails here until it has one', () => {
    expect(Object.keys(FAULT_CODE_RETRYABLE).toSorted()).toEqual([...FAULT_CODES].toSorted());
    for (const code of FAULT_CODES) {
      expect(typeof FAULT_CODE_RETRYABLE[code]).toBe('boolean');
      expect(isFaultRetryable(code)).toBe(FAULT_CODE_RETRYABLE[code]);
    }
  });

  it('is true only for the codes whose identical call can succeed later', () => {
    const retryable = FAULT_CODES.filter((code) => FAULT_CODE_RETRYABLE[code]);
    expect(retryable.toSorted()).toEqual(['RateLimited', 'Timeout', 'Unavailable']);
  });

  it('is false for conflict, absence, validation and authorization codes', () => {
    const permanent = [
      'Conflict',
      'StaleRevision',
      'NotFound',
      'MethodNotFound',
      'InvalidParams',
      'Unprocessable',
      'PayloadTooLarge',
      'Unauthorized',
      'Forbidden',
      'NotImplemented',
      'UnsupportedTransport',
      'UnsupportedCapability',
      'SubscriptionOverflow',
      'EngineFailure',
    ] as const;
    for (const code of permanent) expect(FAULT_CODE_RETRYABLE[code]).toBe(false);
    expect(permanent.length + 3).toBe(FAULT_CODES.length);
  });
});
