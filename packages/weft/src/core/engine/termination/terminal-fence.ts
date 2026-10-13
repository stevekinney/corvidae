import {
  KEYS,
  storageConditionalBatch,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../../storage/interface.ts';
import type { EngineInternals } from '../internals.ts';

/**
 * The durable identity of one terminal commit, used to fence the teardown that
 * follows it.
 *
 * `committedState` is the exact `KEYS.workflow(id)` value the terminal commit
 * wrote. An `onTerminalConflict: 'start-new'` replacement, from this engine or
 * any other, rewrites that key, so a teardown write conditioned on it applies
 * only while the id still belongs to the run that committed. `holderMarker` is
 * the concurrency holder-marker read started before the commit; it names the
 * partition this run's slot lives in even after a replacement purges the marker.
 * Both ride the existing serialized-write resolution, so neither adds an await
 * to the terminal success path. The read is observed for rejection here so an
 * unawaited failure cannot become an unhandled rejection.
 */
export type TerminalFence = {
  readonly committedState: Uint8Array;
  readonly holderMarker: Promise<Uint8Array | null>;
};

/** Start the holder-marker read for a terminal commit, without awaiting it. */
export function startHolderMarkerRead(
  internals: EngineInternals,
  workflowId: string,
): Promise<Uint8Array | null> {
  const read = internals.storage.get(KEYS.workflowConcurrencyHolder(workflowId));
  read.catch(() => undefined);
  return read;
}

/** Whether `current` is byte-identical to `expected`; `null` means the key is absent. */
export function bytesEqual(current: Uint8Array | null, expected: Uint8Array | null): boolean {
  if (current === null || expected === null) return current === expected;
  return current.length === expected.length && current.every((byte, i) => byte === expected[i]);
}

/** The condition that holds only while `KEYS.workflow(id)` is still the committing run's terminal state. */
export function committedStateCondition(
  workflowId: string,
  fence: TerminalFence,
): ConditionalBatchCondition {
  return { key: KEYS.workflow(workflowId), expectedValue: fence.committedState };
}

/**
 * Apply a teardown batch only while the id still belongs to the committing run.
 *
 * With `conditionalBatch` the check is durable and atomic with the write, so it
 * also holds against a replacement started by another engine or landing
 * mid-batch. Storages without that capability keep best-effort same-engine
 * fencing: `isSuperseded` is evaluated immediately before an unconditional
 * batch, which cannot see another engine's replacement or one landing
 * mid-write. Returns whether the batch was applied.
 */
export async function commitFencedTeardownBatch(
  internals: EngineInternals,
  workflowId: string,
  fence: TerminalFence,
  operations: BatchOperation[],
  isSuperseded: () => boolean,
): Promise<boolean> {
  if (isSuperseded()) return false;
  if (internals.storage.capabilities().conditionalBatch) {
    return storageConditionalBatch(
      internals.storage,
      [committedStateCondition(workflowId, fence)],
      operations,
    );
  }
  await internals.storage.batch(operations);
  return true;
}

/** {@link commitFencedTeardownBatch} bound to one terminal commit, for the cleanup helpers' `commitBatch` parameter. */
export function fencedTeardownCommit(
  internals: EngineInternals,
  workflowId: string,
  fence: TerminalFence,
  isSuperseded: () => boolean,
): (operations: BatchOperation[]) => Promise<boolean> {
  return (operations) =>
    commitFencedTeardownBatch(internals, workflowId, fence, operations, isSuperseded);
}
