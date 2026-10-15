import {
  KEYS,
  storageConditionalBatch,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../../storage/interface.ts';
import type { EngineInternals } from '../internals.ts';

/**
 * The durable identity of one run, used to fence the teardown that follows its terminal commit.
 *
 * `generation` is the `wf-gen:<id>` counter observed before the commit. It changes only when the
 * id is reused: an `onTerminalConflict: 'start-new'` restart bumps it in its create batch, from
 * this engine or any other, and nothing else the run does touches it. A teardown write
 * conditioned on it therefore applies only while the id still belongs to the run that committed,
 * and still applies after the same run rewrites its terminal record (for example `addTags`),
 * which a condition on the whole `KEYS.workflow(id)` value would not survive. `holderMarker` is
 * the concurrency holder marker read at the same time; it names the partition this run's slot
 * lives in even after a replacement purges the marker.
 *
 * Both reads are started inside the serialized terminal write and ride its existing resolution,
 * so neither adds an await to the terminal success path. `identity` is observed for rejection
 * here so an unawaited failure cannot become an unhandled rejection; the first teardown step to
 * await it caches the result in `resolved`.
 */
export type TerminalIdentity = {
  readonly generation: Uint8Array | null;
  readonly holderMarker: Uint8Array | null;
};

export type TerminalFence = {
  readonly identity: Promise<TerminalIdentity>;
  resolved?: TerminalIdentity | undefined;
};

/** Start the run-identity reads for a terminal commit, without awaiting them. */
export function startTerminalFence(internals: EngineInternals, workflowId: string): TerminalFence {
  const identity = Promise.all([
    internals.storage.get(KEYS.workflowGeneration(workflowId)),
    internals.storage.get(KEYS.workflowConcurrencyHolder(workflowId)),
  ]).then(([generation, holderMarker]) => ({ generation, holderMarker }));
  identity.catch(() => undefined);
  return { identity };
}

/** Whether `current` is byte-identical to `expected`; `null` means the key is absent. */
export function bytesEqual(current: Uint8Array | null, expected: Uint8Array | null): boolean {
  if (current === null || expected === null) return current === expected;
  return current.length === expected.length && current.every((byte, i) => byte === expected[i]);
}

/** The condition that holds only while `wf-gen:<id>` is still the committing run's generation. */
export function sameRunCondition(
  workflowId: string,
  identity: TerminalIdentity,
): ConditionalBatchCondition {
  return { key: KEYS.workflowGeneration(workflowId), expectedValue: identity.generation };
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
    const identity = fence.resolved ?? (fence.resolved = await fence.identity);
    return storageConditionalBatch(
      internals.storage,
      [sameRunCondition(workflowId, identity)],
      operations,
    );
  }
  await internals.storage.batch(operations);
  return true;
}

/** Maximum deletes per guarded teardown chunk, well under the storage batch limit. */
const GUARDED_DELETE_CHUNK_SIZE = 500;

/**
 * Delete `keys` in chunks, each committed through `fencedCommit`. Stops at the first rejected
 * chunk and reports whether every chunk applied. The keys are listed before they are deleted,
 * so a key written after the listing is never in a batch.
 */
export async function deleteKeysInGuardedChunks(
  keys: AsyncIterable<string>,
  fencedCommit: (operations: BatchOperation[]) => Promise<boolean>,
  initial: BatchOperation[] = [],
): Promise<boolean> {
  let chunk = initial;
  for await (const key of keys) {
    chunk.push({ type: 'delete', key });
    if (chunk.length >= GUARDED_DELETE_CHUNK_SIZE) {
      if (!(await fencedCommit(chunk))) return false;
      chunk = [];
    }
  }
  return chunk.length === 0 || fencedCommit(chunk);
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
