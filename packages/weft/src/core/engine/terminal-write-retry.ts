import {
  KEYS,
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../storage/interface.ts';
import type { RefusedStorageWrite } from './checkpoint-commit-failed-error.ts';
import { commitFencedEngineWriteAllowingPreconditionFailure } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { adapterCall, retryRefusedStorageWrite } from './storage-write-retry.ts';

/**
 * Retry a terminal `wf:<id>` write (a completion or a failure) whose first attempt storage refused
 * with `firstError`, and throw `onLostRace()` when a retry loses a precondition for real.
 *
 * The retry sends the batch the first attempt built, unchanged. A retry that loses its
 * compare-and-swap is not by itself a conflict: the earlier attempt may have landed and only its
 * acknowledgement was lost, which leaves the state the batch was conditioned on changed by this
 * very batch. So after a loss the stored `wf:<id>` is read, and bytes equal to the ones this batch
 * writes mean the write landed and the commit is done. Any other bytes are a genuine loss.
 */
export async function retryTerminalWorkflowStateWrite(
  internals: EngineInternals,
  state: { readonly id: string; readonly workflowExecutionToken?: string | undefined },
  write: Extract<RefusedStorageWrite, 'completion' | 'failure'>,
  operations: BatchOperation[],
  conditions: ConditionalBatchCondition[],
  firstError: unknown,
  onLostRace: () => Error,
): Promise<void> {
  const ownState = operations.find(
    (operation) => operation.type === 'put' && operation.key === KEYS.workflow(state.id),
  );
  const landed = await retryRefusedStorageWrite(
    internals,
    { workflowId: state.id, write, workflowExecutionToken: state.workflowExecutionToken },
    firstError,
    async () => {
      if (
        await commitFencedEngineWriteAllowingPreconditionFailure(
          internals,
          state.id,
          operations,
          conditions,
        )
      ) {
        return true;
      }
      if (ownState?.type !== 'put') return false;
      const stored = await adapterCall(() => internals.storage.get(KEYS.workflow(state.id)));
      return storageValuesEqual(stored, ownState.value);
    },
  );
  if (!landed) throw onLostRace();
}
