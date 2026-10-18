import {
  EvidenceImmutableError,
  EvidenceProjectionBatchLimitError,
  EvidenceProjectionCapacityError,
  EvidenceProjectionCommitError,
  type EvidenceProjectionCommitErrorCode,
  ProjectionRevisionConflictError,
} from './evidence-projection-storage';
import type { MemoryEvidenceRejectionCode } from './evidence-schema';
import { MemoryEvidenceValidationError } from './evidence-schema';
import type { TransitionReceipt } from './transition-receipt';

/**
 * One reason per validator check, in the order the checks run. The candidate
 * count runs first because it needs no reads, and a consolidation with one
 * candidate has nothing to authorize.
 */
export const TRANSITION_VALIDATION_REASONS = [
  'consolidation-requires-two-candidates',
  'unauthorized',
  'evidence-not-covered',
  'source-digest-mismatch',
  'prior-state-not-preserved',
  'temporal-inconsistency',
  'retention-expired',
  'type-invariant-violated',
] as const;
export type TransitionValidationReason = (typeof TRANSITION_VALIDATION_REASONS)[number];

export type TransitionRejectionReason =
  | TransitionValidationReason
  /** A `rebuilt.payload` that fails the stored kind's schema. */
  | 'malformed'
  | Extract<
      EvidenceProjectionCommitErrorCode,
      'invalid-commit' | 'evidence-not-found' | 'projection-not-found'
    >
  | MemoryEvidenceRejectionCode
  | 'batch-limit'
  | 'capacity';

/** A check's refusal: the reason code and a detail naming the record and the rule. */
export type TransitionRefusal = {
  readonly reason: TransitionRejectionReason;
  readonly detail: string;
};

export type TransitionConflictReason =
  | 'stale-revision'
  /** `ProjectionRevisionConflictError`. */
  | 'revision-conflict'
  | 'evidence-superseded'
  | 'projection-terminal'
  | 'evidence-immutable';

/**
 * The five outcomes. Every submission that passes its schema ends in exactly
 * one. `replayed` means the result was settled from a stored receipt, whichever
 * submission wrote it: an exact retry, or a lost batch that turned out to have
 * landed. It does not mean another caller committed the transition.
 */
export type TransitionResult =
  | {
      readonly outcome: 'committed';
      readonly receipt: TransitionReceipt;
      readonly replayed: boolean;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: TransitionRejectionReason;
      readonly detail: string;
    }
  | {
      readonly outcome: 'conflicted';
      readonly reason: TransitionConflictReason;
      readonly detail: string;
    }
  | { readonly outcome: 'canceled' }
  | { readonly outcome: 'unknown'; readonly error: unknown };

type Classified = Extract<TransitionResult, { outcome: 'rejected' | 'conflicted' }>;

/**
 * Maps a store error to an outcome by class and code alone, never by which
 * `commit()` attempt raised it. Returns `undefined` for anything else, which the
 * engine reports as `unknown`.
 */
export function classifyStoreError(error: unknown): Classified | undefined {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof ProjectionRevisionConflictError) {
    return { outcome: 'conflicted', reason: 'revision-conflict', detail };
  }
  if (error instanceof EvidenceImmutableError) {
    return { outcome: 'conflicted', reason: 'evidence-immutable', detail };
  }
  if (error instanceof EvidenceProjectionCommitError) {
    switch (error.code) {
      case 'evidence-superseded':
      case 'projection-terminal':
        return { outcome: 'conflicted', reason: error.code, detail };
      case 'invalid-commit':
      case 'evidence-not-found':
      case 'projection-not-found':
        return { outcome: 'rejected', reason: error.code, detail };
      case 'receipt-exists':
        return undefined;
    }
  }
  if (error instanceof MemoryEvidenceValidationError) {
    return { outcome: 'rejected', reason: error.code, detail };
  }
  if (error instanceof EvidenceProjectionBatchLimitError) {
    return { outcome: 'rejected', reason: 'batch-limit', detail };
  }
  if (error instanceof EvidenceProjectionCapacityError) {
    return { outcome: 'rejected', reason: 'capacity', detail };
  }
  return undefined;
}
