/**
 * `Bureau` has no method that deletes a run. A run leaves when its task ages out under
 * `BureauOptions.taskRetention`, which a durable maintenance pass applies on the runtime clock. A
 * test that needs a settled run gone builds its Bureau on a `ManualRuntimeServices` with
 * `taskRetention: { olderThan: TASK_RETENTION_MILLISECONDS }`, lets the run settle, and calls
 * `retireSettledTasks`.
 */
import type { ManualRuntimeServices } from '@lostgradient/lifecycle';

import type { Bureau, BureauOptions } from '../types';

/** The `taskRetention.olderThan` a test passes so that `retireSettledTasks` retires every settled task. */
export const TASK_RETENTION_MILLISECONDS = 60_000;

/**
 * The retention options a test spreads into its Bureau's options. A durable Bureau also keeps a
 * task for as long as its run-creation request is bound, so that binding is short too.
 */
export const SHORT_TASK_RETENTION: Pick<
  BureauOptions,
  'taskRetention' | 'runCreationTerminalRetentionMs'
> = {
  taskRetention: { olderThan: TASK_RETENTION_MILLISECONDS },
  runCreationTerminalRetentionMs: 1_000,
};

/**
 * Moves `runtime` past the retention window and runs durable maintenance, twice: a task bound to
 * its run-creation request is released a pass after the binding is, never in the same one.
 */
export async function retireSettledTasks(
  bureau: Bureau,
  runtime: ManualRuntimeServices,
): Promise<void> {
  await runtime.advance(TASK_RETENTION_MILLISECONDS + 1);
  await bureau.runDurableMaintenance();
  await bureau.runDurableMaintenance();
}

/**
 * The retention options for a Bureau on the real clock, where a test cannot move time: a settled
 * task is retired as soon as a millisecond has passed since it settled.
 */
export const IMMEDIATE_TASK_RETENTION: Pick<
  BureauOptions,
  'taskRetention' | 'runCreationTerminalRetentionMs'
> = {
  taskRetention: { olderThan: 0 },
  runCreationTerminalRetentionMs: 1,
};

/**
 * `retireSettledTasks` for a Bureau built with `IMMEDIATE_TASK_RETENTION` on the real clock: waits
 * out the millisecond that makes a settled task older than its window, then runs maintenance twice.
 */
export async function retireSettledTasksOnRealClock(bureau: Bureau): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await bureau.runDurableMaintenance();
  await bureau.runDurableMaintenance();
}
