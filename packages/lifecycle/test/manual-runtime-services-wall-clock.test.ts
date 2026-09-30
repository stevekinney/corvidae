import { describe, expect, it } from 'bun:test';

import { createManualRuntimeServices } from '../src/manual-runtime-services';

/**
 * Split out of `manual-runtime-services.test.ts` (AB-292) so the one test that
 * arms a real 60-second timer sits in its own file. It proves `advance()`
 * consumes no real time: if a real timer backed the 60-second virtual advance,
 * the test would exceed the per-test budget and fail, so no reading of the
 * clock is needed.
 */
describe('createManualRuntimeServices', () => {
  describe('timers', () => {
    it('never calls a real timer — advance() settles synchronously with respect to wall-clock time', async () => {
      const runtime = createManualRuntimeServices();
      let fired = false;
      runtime.timers.setTimeout(() => {
        fired = true;
      }, 60_000);

      await runtime.advance(60_000);

      expect(fired).toBe(true);
    });
  });
});
