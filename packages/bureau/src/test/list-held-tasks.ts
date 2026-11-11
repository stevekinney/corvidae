import type { Bureau } from '../bureau-types/facade.ts';
import type { BureauTasks } from '../bureau-types/tasks.ts';
import type { RunDetail } from '../bureau-types/runs.ts';

/**
 * The session tasks this process holds, in the order they were registered, optionally only those
 * whose run status is `status`. A catalog run (session id `''`) is not listed. A test fixture over
 * {@link Bureau.internals}'s run store and {@link BureauTasks.detail}; hosts list tasks with
 * `bureau.tasks.list`.
 */
export function listHeldTasks(
  bureau: { readonly tasks: Pick<BureauTasks, 'detail'> } & {
    readonly internals: Pick<Bureau['internals'], 'store'>;
  },
  status?: string,
): RunDetail[] {
  const held: RunDetail[] = [];
  for (const id of bureau.internals.store.getState().runs.keys()) {
    const detail = bureau.tasks.detail(id);
    if (detail === undefined || detail.sessionId === '') continue;
    if (status !== undefined && detail.status !== status) continue;
    held.push(detail);
  }
  return held;
}
