import { type Storage, storageConditionalBatch, storageKeys } from '@lostgradient/storage';

import { validateEvidenceProjectionKeyPrefixes } from './create-weft-evidence-projection-storage-helpers';
import { DEFAULT_MEMORY_KEY_PREFIX } from './create-weft-memory-record-storage';
import {
  createEvidenceProjectionKeys,
  DEFAULT_EVIDENCE_KEY_PREFIX,
  DEFAULT_PROJECTION_KEY_PREFIX,
} from './evidence-projection-keys';
import type { EvidenceProjectionStorage } from './evidence-projection-storage';
import {
  createEvidenceProjectionStoreCore,
  type WrapApply,
} from './evidence-projection-store-core';

export interface CreateWeftEvidenceProjectionStorageOptions {
  /** Key prefix of the evidence family. Must be disjoint from every other prefix in use. */
  evidenceKeyPrefix?: string;
  /** Key prefix of the projection family. Must be disjoint from every other prefix in use. */
  projectionKeyPrefix?: string;
  /**
   * When `true`, `close()` disposes the underlying {@link Storage}. Defaults to
   * `false`: the backend is a non-owning view over storage shared with a Weft
   * engine.
   */
  disposeUnderlyingStorage?: boolean;
  /** Wraps the store's one write boundary. For tests: fail, count, or park a batch. */
  wrapApply?: WrapApply;
}

/**
 * Creates an {@link EvidenceProjectionStorage} backed by a Weft {@link Storage}.
 *
 * Evidence lives under `DEFAULT_EVIDENCE_KEY_PREFIX` and projections under
 * `DEFAULT_PROJECTION_KEY_PREFIX`, both disjoint from each other, from the
 * record store's `DEFAULT_MEMORY_KEY_PREFIX`, and from Weft's reserved prefixes
 * (checked at construction). Every commit is one `storageConditionalBatch`, so
 * the underlying `Storage` must support compare-and-swap; one that does not
 * fails at the first commit rather than losing a write.
 */
export function createWeftEvidenceProjectionStorage(
  storage: Storage,
  options?: CreateWeftEvidenceProjectionStorageOptions,
): EvidenceProjectionStorage {
  const evidencePrefix = options?.evidenceKeyPrefix ?? DEFAULT_EVIDENCE_KEY_PREFIX;
  const projectionPrefix = options?.projectionKeyPrefix ?? DEFAULT_PROJECTION_KEY_PREFIX;
  const disposeUnderlyingStorage = options?.disposeUnderlyingStorage ?? false;
  validateEvidenceProjectionKeyPrefixes([
    evidencePrefix,
    projectionPrefix,
    DEFAULT_MEMORY_KEY_PREFIX,
  ]);

  const core = createEvidenceProjectionStoreCore({
    keys: createEvidenceProjectionKeys(evidencePrefix, projectionPrefix),
    reader: { get: (key) => storage.get(key), keys: (prefix) => storageKeys(storage, prefix) },
    ...(options?.wrapApply === undefined ? {} : { wrapApply: options.wrapApply }),
    apply: (batch) => storageConditionalBatch(storage, batch.conditions, batch.operations),
  });

  return {
    ...core,
    init: () => Promise.resolve(),
    close(): Promise<void> {
      if (disposeUnderlyingStorage) storage[Symbol.dispose]();
      return Promise.resolve();
    },
  };
}
