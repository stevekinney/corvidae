/**
 * Where an engine status opens: the engine's own run list at `/health/runs`, narrowed to that
 * status. The list reads `weft.workflows.list`, whose `status` filter takes the engine's words as
 * they are, so a count and the list its link opens are the same set. `/runs` is the Bureau's task
 * list, which has five states of its own, and is never where an engine count goes.
 */
import type { WorkflowStatus } from '@lostgradient/weft';

import { ENGINE_RUNS_PATH } from '../../lib/workflow-type-paths.ts';

/** The address of the engine run list narrowed to `status`. */
export function engineRunsPathForStatus(status: WorkflowStatus): string {
  return `${ENGINE_RUNS_PATH}?status=${status}`;
}
