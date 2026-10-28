import { describe, expect, it } from 'bun:test';

import { waitUntil } from '@lostgradient/testing/wait-until';
import { createExecutionLifecycle } from '../src';

/**
 * Split out of execution-lifecycle.test.ts (AB-292) so the
 * scripts/determinism-manifest.json realRuntimeExemptions entry this file
 * needs covers only this one test: it deliberately verifies
 * createExecutionLifecycle's DEFAULT runtime argument (no injected
 * RuntimeServices), i.e. that it schedules deadlines with the real
 * platform timer when the caller supplies none. Injecting a manual
 * runtime here would defeat the point of the test.
 */
describe('execution lifecycle', () => {
  it('schedules deadlines with the platform timer by default', async () => {
    const lifecycle = createExecutionLifecycle();
    const handle = lifecycle.begin({
      toolName: 'deadline',
      callId: 'deadline',
      deadline: Date.now(),
    });

    await waitUntil(() => handle.snapshot().state === 'abort-requested', {
      message: 'the default runtime to fire the deadline',
    });

    expect(handle.snapshot()).toMatchObject({
      state: 'abort-requested',
      abortSource: 'deadline',
    });
    handle.settle();
  });
});
