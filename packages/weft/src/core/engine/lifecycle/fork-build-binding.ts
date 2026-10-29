/**
 * The fork's commit, bound to the deployment build it inherits (COR-1582). A fork copies its
 * source's worker binding, and a finished source is not work a removal's scan counts, so the commit
 * requires the build's removal tombstone to be absent and puts a fresh binding stamp for the
 * build, in the same batch as the run. A commit that loses to the tombstone is told so: the
 * tombstone is re-read before the loss is blamed on the revision catalog.
 *
 * @module core/engine/lifecycle/fork-build-binding
 */

import type { BatchOperation, ConditionalBatchCondition } from '@lostgradient/storage';
import { workerBuildBinding } from '../../../worker/deployment-records.ts';
import { throwIfWorkerBuildRemoved } from '../../../worker/inherited-worker-build.ts';
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
  const { condition, operation } = workerBuildBinding(binding, forkState.id);
  let lostRace = false;
  try {
    await commitFencedEngineWrite(
      internals,
      workflowId,
      [...operations, operation],
      [...catalogConditions, condition],
      () => {
        lostRace = true;
        return onLostRace();
      },
    );
  } catch (error) {
    // Anything but a lost race (a deposed engine, a storage failure) is not about the build.
    if (lostRace) await throwIfWorkerBuildRemoved(internals.storage, binding);
    throw error;
  }
}
