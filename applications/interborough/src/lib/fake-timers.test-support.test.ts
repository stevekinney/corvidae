/**
 * The helpers that wait under Bun's fake timers (`fake-timers.test-support.ts`): `until` returns
 * once its condition holds, and fails with the condition's own error when it never does.
 */
import { rejectionOf } from '@lostgradient/testing';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { settle, until } from './fake-timers.test-support.ts';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('waiting under fake timers', () => {
  test('settle runs what is due now, and moves no clock', async () => {
    let ran = false;
    setTimeout(() => {
      ran = true;
    }, 0);
    setTimeout(() => {
      throw new Error('A timer that is not due ran.');
    }, 1_000);
    await settle(2);
    expect(ran).toBe(true);
  });

  test('until returns as soon as its condition holds, and tries again while it does not', async () => {
    let attempts = 0;
    await until(() => {
      attempts += 1;
      expect(attempts).toBeGreaterThanOrEqual(3);
    });
    expect(attempts).toBe(3);
  });

  test('until fails with the condition’s own error when it never holds', async () => {
    const failure = await rejectionOf(
      until(() => {
        throw new Error('never');
      }, 3),
    );
    expect(failure).toEqual(new Error('never'));
  });
});
