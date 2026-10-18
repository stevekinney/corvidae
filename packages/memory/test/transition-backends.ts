import { MemoryStorage } from '@lostgradient/weft';

import { createInMemoryEvidenceProjectionStorage } from '../src/create-in-memory-evidence-projection-storage';
import { createWeftEvidenceProjectionStorage } from '../src/create-weft-evidence-projection-storage';
import type { EvidenceProjectionStorage } from '../src/evidence-projection-storage';
import type {
  ApplyPlannedBatch,
  PlannedBatch,
  WrapApply,
} from '../src/evidence-projection-store-core';

/** A backend factory that accepts the fault seam every test wraps the store's batch with. */
export type MakeBackend = (wrapApply?: WrapApply) => EvidenceProjectionStorage;

export const TRANSITION_BACKENDS: ReadonlyArray<readonly [string, MakeBackend]> = [
  [
    'in-memory',
    (wrapApply) =>
      createInMemoryEvidenceProjectionStorage(wrapApply === undefined ? {} : { wrapApply }),
  ],
  [
    'weft',
    (wrapApply) =>
      createWeftEvidenceProjectionStorage(
        new MemoryStorage(),
        wrapApply === undefined ? {} : { wrapApply },
      ),
  ],
];

/** Records every batch handed to `apply`, and what it resolved to. */
export interface BatchRecorder {
  readonly wrapApply: WrapApply;
  readonly batches: PlannedBatch[];
  readonly results: boolean[];
}

export function recordBatches(): BatchRecorder {
  const batches: PlannedBatch[] = [];
  const results: boolean[] = [];
  const wrapApply: WrapApply = (apply: ApplyPlannedBatch) => async (batch) => {
    batches.push(batch);
    const applied = await apply(batch);
    results.push(applied);
    return applied;
  };
  return { wrapApply, batches, results };
}

/**
 * Fails the batch the store is about to apply, or has just applied. `before`
 * throws without calling the inner `apply`; `after` applies and then throws.
 * Each fault fires once, on the first batch, so a retry commits normally.
 */
export function failFirstBatch(mode: 'before' | 'after'): {
  readonly wrapApply: WrapApply;
  readonly batches: PlannedBatch[];
} {
  const batches: PlannedBatch[] = [];
  let failed = false;
  const wrapApply: WrapApply = (apply: ApplyPlannedBatch) => async (batch) => {
    batches.push(batch);
    if (failed) return apply(batch);
    failed = true;
    if (mode === 'before') throw new Error('injected fault before the batch applied');
    await apply(batch);
    throw new Error('injected fault after the batch applied');
  };
  return { wrapApply, batches };
}
