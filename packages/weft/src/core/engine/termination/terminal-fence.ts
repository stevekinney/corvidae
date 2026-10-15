import {
  KEYS,
  storageConditionalBatch,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../../storage/interface.ts';
import { currentExecutionAttempt, type RunIdentity } from '../execution-attempts.ts';
import type { EngineInternals } from '../internals.ts';

/**
 * The fence for the teardown that follows one run's terminal commit: the durable identity the
 * engine captured for that run while it was live (see {@link RunIdentity}), or `undefined` when
 * it never learned it. Nothing is read here, so a replacement that lands between the commit and
 * the teardown can never be mistaken for the run. A teardown without an identity fails closed:
 * it skips its fenced durable writes and warns, and the persisted terminal-cleanup timer still
 * sweeps the run's scratch state.
 */
export type TerminalFence = {
  /** The identity as it stands now: read at use, so a read that settles later is still seen. */
  readonly identity: RunIdentity | undefined;
  /** The adoption read still in flight, awaited only by a teardown that finds `identity` unset. */
  readonly pending?: Promise<RunIdentity | undefined> | undefined;
};

/**
 * Capture the fence for a terminal commit of the run identified by `workflowExecutionToken`,
 * from the attempt this engine holds for it. An engine that does not hold that run (a cancel
 * issued from another engine, an attempt of another generation) has no identity to fence on.
 */
export function captureTerminalFence(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): TerminalFence {
  const attempt = currentExecutionAttempt(internals, workflowId);
  if (attempt === undefined || attempt.workflowExecutionToken !== workflowExecutionToken) {
    return { identity: undefined };
  }
  return {
    get identity() {
      return attempt.identity;
    },
    pending: attempt.pendingIdentity,
  };
}

/**
 * The fence for a terminal commit, reading the run's identity first when this engine holds no
 * attempt for it (a cancel or timeout of a run another engine drives). The read happens before
 * the commit is issued, so it cannot observe a replacement: none can exist until the run's
 * terminal commit lands. A fence whose engine does hold the run costs no read and no await.
 */
export function captureOrReadTerminalFence(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): TerminalFence | Promise<TerminalFence> {
  const fence = captureTerminalFence(internals, workflowId, workflowExecutionToken);
  if (fence.identity !== undefined || fence.pending !== undefined) return fence;
  const attempt = currentExecutionAttempt(internals, workflowId);
  if (attempt !== undefined && attempt.workflowExecutionToken === workflowExecutionToken) {
    return fence;
  }
  return readRunIdentity(internals, workflowId).then((identity) => ({ identity }));
}

async function readRunIdentity(
  internals: EngineInternals,
  workflowId: string,
): Promise<RunIdentity> {
  const generation = await internals.storage.get(KEYS.workflowGeneration(workflowId));
  const holderMarker = await internals.storage.get(KEYS.workflowConcurrencyHolder(workflowId));
  return { generation, holderMarker };
}

/** Report that a terminal teardown had no run identity to fence on and skipped its fenced writes. */
export function warnUnknownRunIdentity(
  fence: TerminalFence,
  workflowId: string,
  handleCleanupError: (source: string, error: unknown, workflowId?: string) => void,
): void {
  if (fence.identity !== undefined) return;
  handleCleanupError(
    'terminal-teardown-fence',
    new Error('The run identity is unknown, so its fenced durable teardown was skipped.'),
    workflowId,
  );
}

/** Whether `current` is byte-identical to `expected`; `null` means the key is absent. */
export function bytesEqual(current: Uint8Array | null, expected: Uint8Array | null): boolean {
  if (current === null || expected === null) return current === expected;
  return current.length === expected.length && current.every((byte, i) => byte === expected[i]);
}

/** The condition that holds only while `wf-gen:<id>` is still the committing run's generation. */
export function sameRunCondition(
  workflowId: string,
  identity: RunIdentity,
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
    const identity = fence.identity ?? (await fence.pending);
    if (identity === undefined) return false;
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
