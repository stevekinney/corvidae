/**
 * The removal fence of the deployment build a start binds its run to (COR-1582). A start's create
 * batch requires the build's fence key to be absent, so a run is never committed against a build
 * whose removal has scanned, or has finished. This module builds that tagged condition and answers
 * a commit that lost to it.
 *
 * @module core/engine/lifecycle/start-build-fence
 */

import { storageValuesEqual, type Storage } from '../../../storage/interface.ts';
import { workerBuildFenceAbsentCondition } from '../../../worker/deployment-removal-fence.ts';
import { throwIfWorkerBuildFenced } from '../../../worker/inherited-worker-build.ts';
import type { WorkflowState } from '../../types.ts';
import type { TaggedStartCondition } from './start-condition-tags.ts';

/** How many times a start may commit when a fence it lost to can be released and the commit tried again. */
const FENCE_RETRY_ATTEMPTS = 2;

/** The condition that the build this start binds to is not fenced, or `undefined` for a start with no binding. */
export function workerBuildFenceStartCondition(
  state: WorkflowState,
): TaggedStartCondition | undefined {
  const binding = state.workerBinding?.current;
  return binding === undefined
    ? undefined
    : { source: 'worker-build-fence', condition: workerBuildFenceAbsentCondition(binding) };
}

/** `attempts`, widened so a start that lost to a fence that is gone by the time it re-reads can try again. */
export function startAttemptLimit(attempts: number, state: WorkflowState): number {
  return state.workerBinding === undefined ? attempts : attempts + FENCE_RETRY_ATTEMPTS;
}

/**
 * Answer a start commit that missed: when it was the build's fence that moved, re-read it. The
 * build `removed` or being removed throws the typed error for it; a fence that has been released
 * returns `true`, so the commit is tried again. `false` means the fence was not the cause.
 */
export async function settleLostWorkerBuildFence(
  storage: Storage,
  conditions: readonly TaggedStartCondition[],
  state: WorkflowState,
): Promise<boolean> {
  const entry = conditions.find((candidate) => candidate.source === 'worker-build-fence');
  const binding = state.workerBinding?.current;
  if (entry === undefined || binding === undefined) return false;
  const current = await storage.get(entry.condition.key);
  if (storageValuesEqual(current, entry.condition.expectedValue)) return false;
  await throwIfWorkerBuildFenced(storage, binding);
  return true;
}
