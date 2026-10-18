import type { EvidenceProjectionRecord, ProjectionStatus } from './evidence-projection-schema';
import type { EvidenceRecord, EvidenceSupersession } from './evidence-schema';

/**
 * One atomic write. Everything in it is applied in a single conditional batch,
 * or nothing is.
 */
export interface EvidenceProjectionCommit {
  readonly tenantId: string;
  /** New evidence; a record whose `supersedes` is set also supersedes those predecessors. */
  readonly evidence?: readonly EvidenceRecord[];
  /** One new revision per (namespace, id); revision 1 creates. */
  readonly projections?: readonly EvidenceProjectionRecord[];
}

export interface EvidenceProjectionCommitResult {
  readonly evidence: ReadonlyArray<{
    readonly id: string;
    readonly outcome: 'appended' | 'duplicate';
  }>;
  readonly projections: ReadonlyArray<{
    readonly id: string;
    readonly revision: number;
    readonly outcome: 'written' | 'duplicate';
  }>;
}

/**
 * Persistence contract for immutable evidence and versioned projections.
 *
 * Evidence is append-only: a stored record is never rewritten, and a record is
 * superseded by a later record that names it in `supersedes`, never edited. A
 * projection is identified by `(tenantId, namespace, id)`; the same `id` in
 * another namespace is a different projection, and no cross-namespace
 * uniqueness is enforced or claimed. Every state change of a projection is a new
 * revision, so the full history is kept.
 *
 * `commit()` is the one write primitive. It validates the whole commit, plans
 * every read it depends on as a condition, and applies the writes in one
 * `storageConditionalBatch`, so a correction that supersedes evidence and
 * re-projects it can never be observed half done. It guarantees what the
 * backend's conditional batch does: the batch commits only if every condition
 * still holds. It does not say which condition failed (so a lost batch is
 * re-read and re-planned, up to three attempts) and it does not span two
 * batches (so a caller needing atomicity across kinds puts them in one commit).
 * A backend whose `Storage` cannot do compare-and-swap fails loudly at the first
 * commit instead of losing a write.
 *
 * This contract writes no receipt, emits no event, and takes no operation id;
 * those belong to the transition engine layered over it.
 */
export interface EvidenceProjectionStorage {
  init(): Promise<void>;
  close(): Promise<void>;
  /** Applies everything in one atomic batch, or nothing. */
  commit(commit: EvidenceProjectionCommit): Promise<EvidenceProjectionCommitResult>;
  /** `commit({ tenantId: record.tenantId, evidence: [record] })`, returning that record's outcome. */
  appendEvidence(record: EvidenceRecord): Promise<'appended' | 'duplicate'>;
  /** `commit({ tenantId: record.tenantId, projections: [record] })`, returning that record's outcome. */
  writeProjectionRevision(record: EvidenceProjectionRecord): Promise<'written' | 'duplicate'>;
  getEvidence(tenantId: string, id: string): Promise<EvidenceRecord | undefined>;
  getEvidenceSupersession(tenantId: string, id: string): Promise<EvidenceSupersession | undefined>;
  /** Every marker in the tenant, keyed by the superseded evidence id: one scan. */
  listEvidenceSupersessions(filter: {
    tenantId: string;
  }): Promise<ReadonlyMap<string, EvidenceSupersession>>;
  listEvidence(filter: {
    tenantId: string;
    ownerId?: string;
    includeSuperseded?: boolean;
  }): Promise<EvidenceRecord[]>;
  getProjection(
    tenantId: string,
    namespace: string,
    id: string,
  ): Promise<EvidenceProjectionRecord | undefined>;
  getProjectionRevision(
    tenantId: string,
    namespace: string,
    id: string,
    revision: number,
  ): Promise<EvidenceProjectionRecord | undefined>;
  /** Current revisions, every status unless filtered. */
  listProjections(filter: {
    tenantId: string;
    namespace: string;
    status?: readonly ProjectionStatus[];
  }): Promise<EvidenceProjectionRecord[]>;
  /** Every revision of one projection, oldest first. */
  listProjectionHistory(
    tenantId: string,
    namespace: string,
    id: string,
  ): Promise<EvidenceProjectionRecord[]>;
}

/** A new evidence record's id already exists with different canonical bytes. */
export class EvidenceImmutableError extends Error {
  readonly code = 'evidence-immutable';

  constructor(
    readonly tenantId: string,
    readonly id: string,
  ) {
    super(`Evidence "${id}" already exists with different content; evidence is never rewritten.`);
    this.name = 'EvidenceImmutableError';
  }
}

/**
 * A projection's revision is not the stored current revision plus one, or the
 * commit lost its compare-and-swap. `namespace` is the one namespace every
 * named projection shares, and `undefined` when the commit wrote no projection
 * (`ids` is empty then) or when the named projections span more than one
 * namespace (read `ids` and the commit to tell them apart).
 */
export class ProjectionRevisionConflictError extends Error {
  readonly code = 'revision-conflict';

  constructor(
    readonly tenantId: string,
    readonly namespace: string | undefined,
    readonly ids: readonly string[],
    detail?: string,
  ) {
    super(
      detail ??
        `Projection(s) ${ids.join(', ')} are not at the revision this commit expected; nothing was written.`,
    );
    this.name = 'ProjectionRevisionConflictError';
  }
}

export type EvidenceProjectionCommitErrorCode =
  | 'invalid-commit'
  | 'evidence-not-found'
  | 'evidence-superseded'
  | 'projection-not-found'
  | 'projection-terminal';

export class EvidenceProjectionCommitError extends Error {
  constructor(
    readonly code: EvidenceProjectionCommitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvidenceProjectionCommitError';
  }
}

/**
 * A commit needs more conditions or operations than one conditional batch may
 * hold. Both backends refuse it with this error before applying anything, so
 * they honor one contract; the cap mirrors Weft's `MAX_BATCH_OPERATIONS`.
 */
export class EvidenceProjectionBatchLimitError extends Error {
  readonly code = 'batch-limit';

  constructor(
    readonly target: 'conditions' | 'operations',
    readonly count: number,
    readonly cap: number,
  ) {
    super(
      `The commit needs ${count} ${target}, past the batch cap of ${cap}; nothing was written.`,
    );
    this.name = 'EvidenceProjectionBatchLimitError';
  }
}

/** The bounded in-memory backend refused a commit that would exceed a bound. */
export class EvidenceProjectionCapacityError extends Error {
  readonly code = 'capacity';

  constructor(readonly bound: 'maxEvidence' | 'maxProjectionRevisions') {
    super(`The in-memory evidence and projection store is full (${bound}); nothing was written.`);
    this.name = 'EvidenceProjectionCapacityError';
  }
}
