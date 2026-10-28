import type { CleanupAcknowledgement, ClosedOptions } from '@lostgradient/operative';

import type { Bureau } from '../types.ts';

/**
 * Operative's `closed()` acknowledgement for a task this process holds: it settles once the run's
 * cleanup (asset admission, child runs, the toolbox) has finished. A test fixture over
 * {@link Bureau.internals}'s run store, since a task handle does not carry the call. It
 * throws when this process holds no run for `task`, so call it before the run's record is pruned.
 */
export function closedTask(
  bureau: { readonly internals: Pick<Bureau['internals'], 'store'> },
  task: { readonly id: string },
  options?: ClosedOptions,
): Promise<CleanupAcknowledgement> {
  const held = bureau.internals.store.getRun(task.id)?.activeRun;
  if (held === undefined) {
    throw new Error(`closedTask: this process holds no run for task "${task.id}"`);
  }
  return held.closed(options);
}
