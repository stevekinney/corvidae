import { describe, expect, it } from 'bun:test';

import { sleep } from '../../src/runtime/portable.ts';

const SLEEP_REQUEST_MS = 50;
const SLEEP_UPPER_BOUND_MS = 200;

/**
 * Performance claim moved out of `src/runtime/portable.test.ts`: `sleep(50)` resolves within
 * 200 ms. An upper bound on a real timer measures scheduler load as much as the code, so it runs
 * through `test:benchmarks` rather than the default gate; the default-suite test keeps the lower
 * bound, which load cannot fail.
 */
describe('sleep accuracy', () => {
  it('resolves after approximately the requested duration', async () => {
    const start = performance.now();
    await sleep(SLEEP_REQUEST_MS);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(SLEEP_UPPER_BOUND_MS);
  });
});
