import { describe, expect, it } from 'bun:test';

import { waitUntil } from './wait-until.ts';

/**
 * Weft runs its own copy of `@lostgradient/testing`'s `waitUntil` (`scripts/check-test-support-copies.ts`
 * keeps them equal), and Weft's coverage gate measures the copy, so the one path Weft's own tests never
 * take is exercised here: a condition that never holds ends in the hang guard's failure. The package's
 * own suite covers the rest.
 */
describe('waitUntil in Weft’s copy', () => {
  it('fails naming what it waited for once the hang guard elapses', async () => {
    // hang-guard-self-test: the condition never holds, so no load can satisfy it before the guard
    const failure = await waitUntil(() => false, {
      message: 'a signal that never comes',
      hangGuardMilliseconds: 20,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'waitUntil gave up after 20ms of awake time waiting for a signal that never comes',
    );
  });
});
