import {
  KEYS,
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import type { RefusedStorageWrite } from './checkpoint-commit-failed-error.ts';
import { commitFencedEngineWriteAllowingPreconditionFailure } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { adapterCall, retryRefusedStorageWrite } from './storage-write-retry.ts';
import { decodeWorkflowState } from './validation.ts';

/** Whether `stored` still holds `preImage`: the record as the write was decided from it, unchanged. */
function holdsPreImage(stored: Uint8Array, preImage: Uint8Array): boolean {
  try {
    return storageValuesEqual(encode(decodeWorkflowState(stored)), preImage);
  } catch {
    return false;
  }
}

/**
 * Retry a terminal `wf:<id>` write (a completion or a failure) whose first attempt storage refused
 * with `firstError`, and throw `onLostRace()` when another writer has changed the record.
 *
 * Each retry reads `wf:<id>` before it sends anything:
 *
 * - The record holds this batch's own bytes: the earlier attempt landed and only its
 *   acknowledgement was lost. The write is done and nothing is sent again, so a write that landed
 *   is never applied twice.
 * - The record is no longer what the write was decided from (`state`): another writer changed it,
 *   whatever its status or bytes. Nothing is sent, so the change is never overwritten.
 * - Otherwise the same batch is sent again under the conditions the first attempt used, plus one
 *   more that the record still holds the bytes just read, so a change made after the read loses the
 *   compare-and-swap instead of being overwritten. A storage without `conditionalBatch` cannot
 *   make that guarantee and sends the batch as it is.
 *
 * A retry that loses its compare-and-swap reads the record once more, for a write that landed
 * between the read and the send. Only the bytes of the batch itself count as landed.
 */
export async function retryTerminalWorkflowStateWrite(
  internals: EngineInternals,
  state: WorkflowState,
  write: Extract<RefusedStorageWrite, 'completion' | 'failure'>,
  operations: BatchOperation[],
  conditions: ConditionalBatchCondition[],
  firstError: unknown,
  onLostRace: () => Error,
): Promise<void> {
  const key = KEYS.workflow(state.id);
  const ownState = operations.find(
    (operation) => operation.type === 'put' && operation.key === key,
  );
  const ownBytes = ownState?.type === 'put' ? ownState.value : undefined;
  const preImage = encode(state);
  const isOwnWrite = (stored: Uint8Array | null): boolean =>
    ownBytes !== undefined && storageValuesEqual(stored, ownBytes);
  const landed = await retryRefusedStorageWrite(
    internals,
    { workflowId: state.id, write, workflowExecutionToken: state.workflowExecutionToken },
    firstError,
    async () => {
      const stored = await adapterCall(() => internals.storage.get(key));
      if (isOwnWrite(stored)) return true;
      if (stored === null || !holdsPreImage(stored, preImage)) return false;
      const guarded =
        internals.storage.capabilities().conditionalBatch &&
        !conditions.some((condition) => condition.key === key)
          ? [...conditions, { key, expectedValue: stored }]
          : conditions;
      if (
        await commitFencedEngineWriteAllowingPreconditionFailure(
          internals,
          state.id,
          operations,
          guarded,
        )
      ) {
        return true;
      }
      return isOwnWrite(await adapterCall(() => internals.storage.get(key)));
    },
  );
  if (!landed) throw onLostRace();
}
