/**
 * The fork's commit, fenced against the removal of the deployment build it inherits (COR-1582).
 * A fork copies its source's worker binding, and a finished source is not work a removal's scan
 * counts, so the commit requires the build's removal fence to be absent. A commit that loses to
 * the fence re-reads it, so a build that is removed or being removed is named as such and not
 * reported as a revision that is no longer installed.
 *
 * @module core/engine/lifecycle/fork-build-fence
 */

import {
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../../storage/interface.ts';
import { workerBuildFenceAbsentCondition } from '../../../worker/deployment-removal-fence.ts';
import { WorkerDeploymentVersionRemovingError } from '../../../worker/deployment-version-removed-error.ts';
import { throwIfWorkerBuildFenced } from '../../../worker/inherited-worker-build.ts';
import type { WorkflowState } from '../../types.ts';
import { commitFencedEngineWrite } from '../fenced-write.ts';
import type { EngineInternals } from '../internals.ts';

export async function commitForkWrite(
  internals: EngineInternals,
  workflowId: string,
  operations: BatchOperation[],
  catalogConditions: ConditionalBatchCondition[],
  forkState: WorkflowState,
  onLostRace: () => Error,
): Promise<void> {
  const binding = forkState.workerBinding?.current;
  if (binding === undefined) {
    return commitFencedEngineWrite(
      internals,
      workflowId,
      operations,
      catalogConditions,
      onLostRace,
    );
  }
  let lostRace = false;
  try {
    await commitFencedEngineWrite(
      internals,
      workflowId,
      operations,
      [...catalogConditions, workerBuildFenceAbsentCondition(binding)],
      () => {
        lostRace = true;
        return onLostRace();
      },
    );
  } catch (error) {
    // Anything but a lost race (a deposed engine, a storage failure) is not about the fence.
    if (!lostRace) throw error;
    // Fenced or removed: say which. Otherwise, if every other condition still holds, the loss was
    // to a fence that has since been released.
    await throwIfWorkerBuildFenced(internals.storage, binding);
    for (const { key, expectedValue } of catalogConditions) {
      if (!storageValuesEqual(await internals.storage.get(key), expectedValue)) throw error;
    }
    throw new WorkerDeploymentVersionRemovingError(binding.deploymentName, binding.buildId);
  }
}
