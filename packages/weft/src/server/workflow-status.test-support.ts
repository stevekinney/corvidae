/**
 * Shared test-only helper for polling an engine until a workflow reaches a
 * target status. Used by bulk-operation REST behavior tests and the
 * JSON-RPC WebSocket integration test, which otherwise each carried an
 * identical copy of this loop.
 *
 * This module is test-only (`.test-support.ts` is excluded from the production
 * build) and must never be imported by production server code.
 */

import type { Engine } from '../core/engine.ts';

import { awakeTurns } from '../../scripts/lib/wait-until.ts';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

/** Terminal and intermediate workflow statuses the tests wait on. */
export type WaitableWorkflowStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out';

/**
 * Poll `engine.get(workflowId)` until the workflow reports `status`. Polls every 5ms via
 * `sleepForTesting` and gives up only on the awake-time hang guard, never on a count of
 * milliseconds a loaded host can overrun.
 */
export async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: WaitableWorkflowStatus,
): Promise<void> {
  for await (const _turn of awakeTurns()) {
    const state = await engine.get(workflowId);
    if (state?.status === status) {
      return;
    }
    await sleepForTesting(5);
  }

  throw new Error(`Workflow ${workflowId} did not reach ${status} before the hang guard elapsed`);
}
