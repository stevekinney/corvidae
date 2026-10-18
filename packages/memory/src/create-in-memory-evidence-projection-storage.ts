import { createEvidenceProjectionKeys } from './evidence-projection-keys';
import {
  EvidenceProjectionCapacityError,
  type EvidenceProjectionStorage,
} from './evidence-projection-storage';
import {
  createEvidenceProjectionStoreCore,
  type PlannedBatch,
  type WrapApply,
} from './evidence-projection-store-core';

/** Default bound on stored evidence records, superseded ones included. */
export const DEFAULT_MAX_IN_MEMORY_EVIDENCE = 10_000;
/** Default bound on stored projection revisions across every projection, history included. */
export const DEFAULT_MAX_IN_MEMORY_PROJECTION_REVISIONS = 50_000;

export interface CreateInMemoryEvidenceProjectionStorageOptions {
  /** Most evidence records the store holds, superseded ones included. */
  maxEvidence?: number;
  /** Most projection revisions the store holds across every projection, history included. */
  maxProjectionRevisions?: number;
  /** Wraps the store's one write boundary. For tests: fail, count, or park a batch. */
  wrapApply?: WrapApply;
}

function requireBound(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * A bounded, standalone {@link EvidenceProjectionStorage} for Agent use without
 * Bureau or Weft. It satisfies the same contract suite as the Weft-backed store
 * and keeps its records under the same key layout. Bureau supplies durable
 * storage; the keys are an implementation detail and never part of the public
 * surface.
 *
 * A commit that would push the store past `maxEvidence` or
 * `maxProjectionRevisions` throws {@link EvidenceProjectionCapacityError}
 * before applying anything. Nothing is ever evicted: evidence is the source of
 * truth, and dropping any of it silently would be data loss.
 */
export function createInMemoryEvidenceProjectionStorage(
  options?: CreateInMemoryEvidenceProjectionStorageOptions,
): EvidenceProjectionStorage {
  const maxEvidence = requireBound(
    'maxEvidence',
    options?.maxEvidence ?? DEFAULT_MAX_IN_MEMORY_EVIDENCE,
  );
  const maxProjectionRevisions = requireBound(
    'maxProjectionRevisions',
    options?.maxProjectionRevisions ?? DEFAULT_MAX_IN_MEMORY_PROJECTION_REVISIONS,
  );
  const store = new Map<string, Uint8Array>();
  let evidenceCount = 0;
  let revisionCount = 0;

  /** Checks and applies in one synchronous step, so no other commit can interleave. */
  function apply(batch: PlannedBatch): Promise<boolean> {
    for (const condition of batch.conditions) {
      const current = store.get(condition.key) ?? null;
      const holds =
        condition.expectedValue === null
          ? current === null
          : current !== null && bytesEqual(current, condition.expectedValue);
      if (!holds) return Promise.resolve(false);
    }
    if (evidenceCount + batch.newEvidence > maxEvidence) {
      throw new EvidenceProjectionCapacityError('maxEvidence');
    }
    if (revisionCount + batch.newProjectionRevisions > maxProjectionRevisions) {
      throw new EvidenceProjectionCapacityError('maxProjectionRevisions');
    }
    for (const operation of batch.operations) store.set(operation.key, operation.value.slice());
    evidenceCount += batch.newEvidence;
    revisionCount += batch.newProjectionRevisions;
    return Promise.resolve(true);
  }

  const core = createEvidenceProjectionStoreCore({
    keys: createEvidenceProjectionKeys(),
    apply,
    ...(options?.wrapApply === undefined ? {} : { wrapApply: options.wrapApply }),
    reader: {
      get: (key) => Promise.resolve(store.get(key)?.slice() ?? null),
      async *keys(prefix) {
        for (const key of store.keys()) {
          if (key.startsWith(prefix)) yield key;
        }
      },
    },
  });

  return {
    ...core,
    init: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}
