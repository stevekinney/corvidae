import { waitForRunState } from '@lostgradient/operative';

import type { BureauTasks, RunDetail } from '../types.ts';

/**
 * Waits until `bureau.tasks.detail(taskId)` satisfies `predicate` (by default, until the task is no
 * longer `running`) and resolves with that detail. Operative's `waitForRunState` over the task
 * reads of a Bureau.
 */
export function waitForTaskState(
  bureau: { readonly tasks: Pick<BureauTasks, 'detail'> },
  taskId: string,
  predicate?: (detail: RunDetail) => boolean,
): Promise<RunDetail> {
  return waitForRunState({ getRun: (id) => bureau.tasks.detail(id) }, taskId, predicate);
}
