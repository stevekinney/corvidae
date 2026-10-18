import type { EvidenceProjectionKeys } from './evidence-projection-keys';
import {
  decodeEmbeddingProfile,
  decodeEvidenceProjectionRecord,
  type EmbeddingProfile,
  embeddingProfileOf,
  encodeEmbeddingProfile,
  encodeEvidenceProjectionRecord,
  type EvidenceProjectionRecord,
  type ProjectionReference,
  type ProjectionStatus,
  sameEmbeddingProfile,
} from './evidence-projection-schema';
import {
  EvidenceImmutableError,
  EvidenceProjectionBatchLimitError,
  type EvidenceProjectionCommit,
  EvidenceProjectionCommitError,
  type EvidenceProjectionCommitResult,
  type EvidenceProjectionRawReads,
  type EvidenceProjectionStorage,
  ProjectionRevisionConflictError,
  RAW_READS,
} from './evidence-projection-storage';
import {
  decodeEvidenceRecord,
  decodeEvidenceSupersession,
  digestOfText,
  encodeEvidenceRecord,
  encodeEvidenceSupersession,
  type EvidenceRecord,
  type EvidenceSupersession,
  MemoryEvidenceValidationError,
} from './evidence-schema';

/**
 * The backend-independent half of the evidence and projection stores. The
 * Weft-backed and the in-memory backends differ only in how they read keys and
 * how they apply a planned batch atomically; validation, planning, and every
 * read live here once, so both clear the same contract by construction.
 */

export interface KeyValueReader {
  get(key: string): Promise<Uint8Array | null>;
  keys(prefix: string): AsyncIterable<string>;
}

export interface PlannedCondition {
  readonly key: string;
  readonly expectedValue: Uint8Array | null;
}

export interface PlannedPut {
  readonly type: 'put';
  readonly key: string;
  readonly value: Uint8Array;
}

export interface PlannedBatch {
  readonly conditions: PlannedCondition[];
  readonly operations: PlannedPut[];
  /** Evidence records this batch adds, for a bounded backend's capacity check. */
  readonly newEvidence: number;
  /** Projection revisions this batch adds (history entries), likewise. */
  readonly newProjectionRevisions: number;
}

/** Applies the batch only if every condition still holds. Resolves to whether it did. */
export type ApplyPlannedBatch = (batch: PlannedBatch) => Promise<boolean>;

/**
 * Most conditions, and most operations, one commit's batch may hold. It mirrors
 * Weft's `MAX_BATCH_OPERATIONS`; a Weft-only test asserts the two are equal, so
 * the in-memory backend refuses exactly what the Weft-backed one would.
 */
export const MAX_COMMIT_BATCH_OPERATIONS = 10_000;

/** A commit is re-read and re-planned at most this many times when its batch is lost. */
const MAXIMUM_COMMIT_ATTEMPTS = 3;

const textDecoder = new TextDecoder();

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function parseJson(bytes: Uint8Array, record: 'evidence' | 'projection'): unknown {
  try {
    return JSON.parse(textDecoder.decode(bytes));
  } catch {
    throw new MemoryEvidenceValidationError('malformed', record, `A stored ${record} is not JSON.`);
  }
}

function malformedKey(record: 'evidence' | 'projection', detail: string): never {
  throw new MemoryEvidenceValidationError('malformed', record, detail);
}

function projectionLabel(record: { id: string; revision: number }): string {
  return `${record.id}@${record.revision}`;
}

function referencesOf(record: EvidenceProjectionRecord): ProjectionReference[] {
  const references: ProjectionReference[] = [];
  const { transition } = record;
  if (transition.kind === 'created' && transition.supersedes !== undefined) {
    references.push(...transition.supersedes);
  }
  if (transition.kind === 'superseded') references.push(transition.supersededBy);
  if (transition.kind === 'demoted') references.push(transition.demotedBy);
  if (record.kind === 'summary') references.push(...record.payload.covers);
  return references;
}

/** Whether a source's digest chain begins at the evidence and ends at the chunk text. */
function chunkChainBroken(record: EvidenceProjectionRecord, evidenceDigest: string): boolean {
  if (record.kind !== 'chunk') return false;
  const { steps } = record.payload;
  const first = steps[0];
  const last = steps.at(-1);
  if (first === undefined || last === undefined) return true;
  if (first.inputDigest !== evidenceDigest) return true;
  if (last.step !== 'chunk' || last.outputDigest !== digestOfText(record.payload.text)) return true;
  return steps.some(
    (step, index) => index > 0 && step.inputDigest !== steps[index - 1]?.outputDigest,
  );
}

function digestMismatch(detail: string): never {
  throw new MemoryEvidenceValidationError('digest-mismatch', 'projection', detail);
}

/**
 * A projection revision's address within a commit. A tuple, not a delimited
 * string: namespaces and ids may contain any character, so no delimiter keeps
 * (`a`, `b\0c`) apart from (`a\0b`, `c`).
 */
function addressOf(record: { namespace: string; id: string; revision: number }): string {
  return JSON.stringify([record.namespace, record.id, record.revision]);
}

/**
 * A reference to a projection revision this commit also writes is not checked
 * against storage, so it must not be able to point back at itself: a revision
 * that supersedes or covers itself, directly or through other new revisions, is
 * refused. References to stored revisions cannot close a loop, since stored
 * revisions are immutable and cannot refer to a revision written later.
 */
function assertNoReferenceCycle(projections: readonly EvidenceProjectionRecord[]): void {
  const edges = new Map<string, string[]>();
  for (const record of projections) {
    edges.set(
      addressOf(record),
      referencesOf(record).map((reference) =>
        addressOf({ ...reference, namespace: record.namespace }),
      ),
    );
  }
  const finished = new Set<string>();
  const visit = (address: string, path: ReadonlySet<string>): void => {
    if (finished.has(address)) return;
    if (path.has(address)) {
      throw new EvidenceProjectionCommitError(
        'invalid-commit',
        'The commit contains a projection revision that refers to itself, directly or through others.',
      );
    }
    const next = new Set(path).add(address);
    for (const target of edges.get(address) ?? []) if (edges.has(target)) visit(target, next);
    finished.add(address);
  };
  for (const address of edges.keys()) visit(address, new Set());
}

/** A record this commit gives an embedding to: a created or rebuilt revision that carries one. */
function writesEmbedding(record: EvidenceProjectionRecord): record is EvidenceProjectionRecord & {
  embedding: NonNullable<EvidenceProjectionRecord['embedding']>;
} {
  return (
    record.embedding !== undefined &&
    (record.transition.kind === 'created' || record.transition.kind === 'rebuilt')
  );
}

/** Two embedded records written to one namespace by one commit must share a profile. */
function assertOneProfilePerNamespace(projections: readonly EvidenceProjectionRecord[]): void {
  const profiles = new Map<string, EmbeddingProfile>();
  for (const record of projections) {
    if (!writesEmbedding(record)) continue;
    const profile = embeddingProfileOf(record.embedding);
    const earlier = profiles.get(record.namespace);
    if (earlier !== undefined && !sameEmbeddingProfile(earlier, profile)) {
      throw new EvidenceProjectionCommitError(
        'invalid-commit',
        `The commit writes embeddings with two profiles into namespace "${record.namespace}".`,
      );
    }
    profiles.set(record.namespace, profile);
  }
}

function assertWithinBatchCap(batch: PlannedBatch): void {
  if (batch.conditions.length > MAX_COMMIT_BATCH_OPERATIONS) {
    throw new EvidenceProjectionBatchLimitError(
      'conditions',
      batch.conditions.length,
      MAX_COMMIT_BATCH_OPERATIONS,
    );
  }
  if (batch.operations.length > MAX_COMMIT_BATCH_OPERATIONS) {
    throw new EvidenceProjectionBatchLimitError(
      'operations',
      batch.operations.length,
      MAX_COMMIT_BATCH_OPERATIONS,
    );
  }
}

/** Accumulates the conditions and puts of one commit while it is being planned. */
class BatchPlan {
  readonly conditions = new Map<string, Uint8Array | null>();
  readonly operations: PlannedPut[] = [];
  newEvidence = 0;
  newProjectionRevisions = 0;

  require(key: string, expectedValue: Uint8Array | null): void {
    this.conditions.set(key, expectedValue);
  }

  put(key: string, value: Uint8Array): void {
    this.operations.push({ type: 'put', key, value });
  }

  toBatch(): PlannedBatch {
    return {
      conditions: [...this.conditions].map(([key, expectedValue]) => ({ key, expectedValue })),
      operations: this.operations,
      newEvidence: this.newEvidence,
      newProjectionRevisions: this.newProjectionRevisions,
    };
  }
}

/**
 * Wraps the backend's `apply`, so a test can fail, count, or park a batch at
 * the store's one write boundary. Production code never sets it.
 */
export type WrapApply = (apply: ApplyPlannedBatch) => ApplyPlannedBatch;

export type EvidenceProjectionStoreCore = Omit<EvidenceProjectionStorage, 'init' | 'close'>;

export function createEvidenceProjectionStoreCore(options: {
  readonly reader: KeyValueReader;
  readonly apply: ApplyPlannedBatch;
  readonly keys: EvidenceProjectionKeys;
  readonly wrapApply?: WrapApply;
}): EvidenceProjectionStoreCore {
  const { reader, keys } = options;
  const apply = options.wrapApply?.(options.apply) ?? options.apply;

  async function scan(prefix: string): Promise<string[]> {
    const found: string[] = [];
    for await (const key of reader.keys(prefix)) found.push(key);
    return found.toSorted();
  }

  async function readStoredEvidence(
    tenantId: string,
    id: string,
  ): Promise<{ raw: Uint8Array; record: EvidenceRecord } | undefined> {
    const raw = await reader.get(keys.evidence(tenantId, id));
    if (raw === null) return undefined;
    const record = decodeEvidenceRecord(parseJson(raw, 'evidence'), { tenantId });
    if (record.id !== id)
      malformedKey('evidence', `Evidence stored under "${id}" says it is "${record.id}".`);
    return { raw, record };
  }

  async function readStoredProjection(
    key: string,
    expected: { tenantId: string; namespace: string; id: string; revision?: number },
  ): Promise<{ raw: Uint8Array; record: EvidenceProjectionRecord } | undefined> {
    const raw = await reader.get(key);
    if (raw === null) return undefined;
    const record = decodeEvidenceProjectionRecord(parseJson(raw, 'projection'), {
      tenantId: expected.tenantId,
    });
    const keyed = record.namespace === expected.namespace && record.id === expected.id;
    if (!keyed || (expected.revision !== undefined && record.revision !== expected.revision)) {
      malformedKey('projection', `A projection stored under ${key} disagrees with its key.`);
    }
    return { raw, record };
  }

  async function planEvidence(
    builder: BatchPlan,
    tenantId: string,
    evidence: readonly EvidenceRecord[],
  ): Promise<{
    appended: Map<string, EvidenceRecord>;
    outcomes: EvidenceProjectionCommitResult['evidence'];
  }> {
    const appended = new Map<string, EvidenceRecord>();
    const outcomes: Array<EvidenceProjectionCommitResult['evidence'][number]> = [];
    for (const record of evidence) {
      const key = keys.evidence(tenantId, record.id);
      const bytes = encodeEvidenceRecord(record);
      const stored = await readStoredEvidence(tenantId, record.id);
      if (stored === undefined) {
        builder.require(key, null);
        builder.put(key, bytes);
        builder.newEvidence += 1;
        appended.set(record.id, record);
        outcomes.push({ id: record.id, outcome: 'appended' });
        await planSupersession(builder, tenantId, record);
        continue;
      }
      if (!bytesEqual(encodeEvidenceRecord(stored.record), bytes)) {
        throw new EvidenceImmutableError(tenantId, record.id);
      }
      builder.require(key, stored.raw);
      outcomes.push({ id: record.id, outcome: 'duplicate' });
    }
    return { appended, outcomes };
  }

  async function planSupersession(
    builder: BatchPlan,
    tenantId: string,
    successor: EvidenceRecord,
  ): Promise<void> {
    for (const predecessorId of successor.supersedes ?? []) {
      const predecessor = await readStoredEvidence(tenantId, predecessorId);
      if (predecessor === undefined) {
        throw new EvidenceProjectionCommitError(
          'evidence-not-found',
          `Evidence "${successor.id}" supersedes "${predecessorId}", which is not stored.`,
        );
      }
      const markerKey = keys.supersession(tenantId, predecessorId);
      if ((await reader.get(markerKey)) !== null) {
        throw new EvidenceProjectionCommitError(
          'evidence-superseded',
          `Evidence "${predecessorId}" is already superseded.`,
        );
      }
      builder.require(keys.evidence(tenantId, predecessorId), predecessor.raw);
      builder.require(markerKey, null);
      builder.put(
        markerKey,
        encodeEvidenceSupersession({
          schemaVersion: 1,
          supersededBy: successor.id,
          at: successor.writtenAt,
        }),
      );
    }
  }

  async function planSources(
    builder: BatchPlan,
    record: EvidenceProjectionRecord,
    appended: ReadonlyMap<string, EvidenceRecord>,
    supersededNow: ReadonlySet<string>,
  ): Promise<void> {
    const { tenantId } = record;
    const chunkSource = record.sources[0];
    for (const source of record.sources) {
      // Evidence this very commit supersedes has no marker yet, so the read below would not see
      // it; a projection resting on it would be active the moment it is written.
      if (supersededNow.has(source.evidenceId)) {
        throw new EvidenceProjectionCommitError(
          'evidence-superseded',
          `Projection ${projectionLabel(record)} is built from evidence "${source.evidenceId}", which this commit supersedes.`,
        );
      }
      const inCommit = appended.get(source.evidenceId);
      let evidenceDigest: string;
      if (inCommit === undefined) {
        const stored = await readStoredEvidence(tenantId, source.evidenceId);
        if (stored === undefined) {
          throw new EvidenceProjectionCommitError(
            'evidence-not-found',
            `Projection ${projectionLabel(record)} names evidence "${source.evidenceId}", which is not stored.`,
          );
        }
        evidenceDigest = stored.record.digest;
        if (evidenceDigest !== source.digest) {
          digestMismatch(
            `Projection ${projectionLabel(record)} records a digest for "${source.evidenceId}" that differs from the stored evidence.`,
          );
        }
        const markerKey = keys.supersession(tenantId, source.evidenceId);
        if ((await reader.get(markerKey)) !== null) {
          throw new EvidenceProjectionCommitError(
            'evidence-superseded',
            `Projection ${projectionLabel(record)} is built from superseded evidence "${source.evidenceId}".`,
          );
        }
        builder.require(keys.evidence(tenantId, source.evidenceId), stored.raw);
        builder.require(markerKey, null);
      } else {
        evidenceDigest = inCommit.digest;
        if (evidenceDigest !== source.digest) {
          digestMismatch(
            `Projection ${projectionLabel(record)} records a digest for "${source.evidenceId}" that differs from the evidence in this commit.`,
          );
        }
      }
      if (source === chunkSource && chunkChainBroken(record, evidenceDigest)) {
        digestMismatch(`Chunk ${projectionLabel(record)} has a broken digest chain.`);
      }
    }
  }

  async function planReferences(
    record: EvidenceProjectionRecord,
    inCommit: ReadonlySet<string>,
  ): Promise<void> {
    for (const reference of referencesOf(record)) {
      const address = addressOf({ namespace: record.namespace, ...reference });
      if (inCommit.has(address)) continue;
      const stored = await reader.get(
        keys.history(record.tenantId, record.namespace, reference.id, reference.revision),
      );
      if (stored === null) {
        throw new EvidenceProjectionCommitError(
          'projection-not-found',
          `Projection ${projectionLabel(record)} refers to ${projectionLabel(reference)}, which does not exist.`,
        );
      }
    }
  }

  function assertSuccession(
    current: EvidenceProjectionRecord,
    next: EvidenceProjectionRecord,
  ): void {
    if (next.revision !== current.revision + 1) {
      throw new ProjectionRevisionConflictError(next.tenantId, next.namespace, [next.id]);
    }
    if (current.status === 'superseded' || current.status === 'revoked') {
      throw new EvidenceProjectionCommitError(
        'projection-terminal',
        `Projection ${projectionLabel(current)} is ${current.status}; no further revision is allowed.`,
      );
    }
    if (next.kind !== current.kind) {
      throw new EvidenceProjectionCommitError(
        'invalid-commit',
        `Projection "${next.id}" changes kind; a kind change is a new projection.`,
      );
    }
    const preserving = next.transition.kind !== 'rebuilt';
    if (preserving) {
      const unchanged =
        JSON.stringify(next.sources) === JSON.stringify(current.sources) &&
        JSON.stringify(next.payload) === JSON.stringify(current.payload) &&
        JSON.stringify(next.embedding) === JSON.stringify(current.embedding);
      if (!unchanged) {
        throw new EvidenceProjectionCommitError(
          'invalid-commit',
          `A ${next.transition.kind} revision of "${next.id}" must keep its sources, payload, and embedding.`,
        );
      }
    }
  }

  async function planProjections(
    builder: BatchPlan,
    projections: readonly EvidenceProjectionRecord[],
    appended: ReadonlyMap<string, EvidenceRecord>,
  ): Promise<EvidenceProjectionCommitResult['projections']> {
    const inCommit = new Set(projections.map(addressOf));
    const supersededNow = new Set(
      [...appended.values()].flatMap((record) => record.supersedes ?? []),
    );
    const outcomes: Array<EvidenceProjectionCommitResult['projections'][number]> = [];
    for (const record of projections) {
      const { tenantId, namespace, id } = record;
      const currentKey = keys.current(tenantId, namespace, id);
      const bytes = encodeEvidenceProjectionRecord(record);
      const stored = await readStoredProjection(currentKey, { tenantId, namespace, id });
      if (
        stored !== undefined &&
        bytesEqual(encodeEvidenceProjectionRecord(stored.record), bytes)
      ) {
        builder.require(currentKey, stored.raw);
        outcomes.push({ id, revision: record.revision, outcome: 'duplicate' });
        continue;
      }
      if (stored === undefined) {
        if (record.revision !== 1) {
          throw new ProjectionRevisionConflictError(tenantId, namespace, [id]);
        }
        builder.require(currentKey, null);
      } else {
        assertSuccession(stored.record, record);
        builder.require(currentKey, stored.raw);
      }
      if (record.transition.kind === 'created' || record.transition.kind === 'rebuilt') {
        await planSources(builder, record, appended, supersededNow);
      }
      await planReferences(record, inCommit);
      const historyKey = keys.history(tenantId, namespace, id, record.revision);
      builder.require(historyKey, null);
      builder.put(historyKey, bytes);
      builder.put(currentKey, bytes);
      builder.newProjectionRevisions += 1;
      outcomes.push({ id, revision: record.revision, outcome: 'written' });
    }
    return outcomes;
  }

  function validateCommit(commit: EvidenceProjectionCommit): {
    evidence: EvidenceRecord[];
    projections: EvidenceProjectionRecord[];
  } {
    const { tenantId } = commit;
    const evidence = (commit.evidence ?? []).map((record) =>
      decodeEvidenceRecord(record, { tenantId }),
    );
    const projections = (commit.projections ?? []).map((record) =>
      decodeEvidenceProjectionRecord(record, { tenantId }),
    );
    const invalid = (message: string): never => {
      throw new EvidenceProjectionCommitError('invalid-commit', message);
    };
    if (evidence.length === 0 && projections.length === 0) invalid('The commit is empty.');
    const { receipt } = commit;
    if (receipt !== undefined && receipt.key.length === 0) {
      invalid('The commit receipt needs a non-empty key.');
    }
    if (commit.readSet?.some((entry) => entry.key.length === 0) === true) {
      invalid('A read set entry needs a non-empty key.');
    }
    const evidenceIds = new Set(evidence.map((record) => record.id));
    if (evidenceIds.size !== evidence.length) invalid('The commit repeats an evidence id.');
    const addresses = projections.map((record) => JSON.stringify([record.namespace, record.id]));
    if (new Set(addresses).size !== projections.length) {
      invalid('The commit writes one projection twice.');
    }
    const predecessors = evidence.flatMap((record) => record.supersedes ?? []);
    if (new Set(predecessors).size !== predecessors.length) {
      invalid('The commit supersedes one evidence record more than once.');
    }
    if (predecessors.some((predecessor) => evidenceIds.has(predecessor))) {
      invalid('The commit supersedes evidence it also appends.');
    }
    assertNoReferenceCycle(projections);
    assertOneProfilePerNamespace(projections);
    return { evidence, projections };
  }

  /** A receipt key that another write of the same batch uses, or that lies in a record family, would overwrite a record. */
  function planReceipt(
    builder: BatchPlan,
    receipt: NonNullable<EvidenceProjectionCommit['receipt']>,
  ): void {
    const collides =
      builder.conditions.has(receipt.key) ||
      builder.operations.some((operation) => operation.key === receipt.key) ||
      receipt.key.startsWith(keys.evidencePrefix) ||
      receipt.key.startsWith(keys.projectionPrefix);
    if (collides) {
      throw new EvidenceProjectionCommitError(
        'invalid-commit',
        `The commit receipt key "${receipt.key}" collides with a record key.`,
      );
    }
  }

  async function readEmbeddingProfile(
    tenantId: string,
    namespace: string,
  ): Promise<{ raw: Uint8Array; profile: EmbeddingProfile } | undefined> {
    const raw = await reader.get(keys.embeddingProfile(tenantId, namespace));
    if (raw === null) return undefined;
    return { raw, profile: decodeEmbeddingProfile(parseJson(raw, 'projection')) };
  }

  /**
   * Whether the namespace would still hold a recallable embedded record whose
   * profile is not `incoming` once the commit applied: stored `active` or
   * `demoted` current revisions the commit does not replace, plus what the
   * commit itself writes. A demoted revision keeps its embedding recallable, so
   * demoting is not retiring.
   */
  async function recallableMismatch(
    tenantId: string,
    namespace: string,
    incoming: EmbeddingProfile,
    commitRecords: readonly EvidenceProjectionRecord[],
  ): Promise<string | undefined> {
    const replaced = new Set(commitRecords.map((record) => record.id));
    const prefix = keys.currentScan(tenantId, namespace);
    for (const key of await scan(prefix)) {
      const id = keys.idOfCurrentKey(key, prefix);
      if (replaced.has(id)) continue;
      const current = await getProjection(tenantId, namespace, id);
      if (current === undefined || current.embedding === undefined) continue;
      if (current.status !== 'active' && current.status !== 'demoted') continue;
      if (!sameEmbeddingProfile(embeddingProfileOf(current.embedding), incoming)) return id;
    }
    for (const record of commitRecords) {
      const recallable = record.status === 'active' || record.status === 'demoted';
      if (
        recallable &&
        record.embedding !== undefined &&
        !sameEmbeddingProfile(embeddingProfileOf(record.embedding), incoming)
      ) {
        return record.id;
      }
    }
    return undefined;
  }

  /**
   * Plans each namespace's embedding profile marker for the embedded records
   * the commit writes. The marker is read and conditioned in the same batch as
   * the records, so two commits that would give a namespace incompatible
   * embeddings cannot both apply: they condition on one key, and the loser
   * re-plans against the winner's marker.
   *
   * - No marker: scan once for a recallable embedded record of another
   *   profile (a namespace that predates the marker), then put the marker.
   * - The same profile: condition on the marker's exact bytes, no scan, no put.
   * - Another profile: allowed only when the commit leaves no recallable
   *   embedded record of the old profile; then replace the marker by
   *   compare-and-swap. Otherwise `embedding-profile-conflict`.
   *
   * A commit that writes no embedded record never touches a marker.
   */
  async function planEmbeddingProfiles(
    builder: BatchPlan,
    projections: readonly EvidenceProjectionRecord[],
    outcomes: EvidenceProjectionCommitResult['projections'],
  ): Promise<void> {
    const incoming = new Map<string, { tenantId: string; profile: EmbeddingProfile }>();
    projections.forEach((record, index) => {
      if (outcomes[index]?.outcome !== 'written' || !writesEmbedding(record)) return;
      incoming.set(record.namespace, {
        tenantId: record.tenantId,
        profile: embeddingProfileOf(record.embedding),
      });
    });
    for (const [namespace, { tenantId, profile }] of incoming) {
      const key = keys.embeddingProfile(tenantId, namespace);
      const stored = await readEmbeddingProfile(tenantId, namespace);
      if (stored !== undefined && sameEmbeddingProfile(stored.profile, profile)) {
        builder.require(key, stored.raw);
        continue;
      }
      const inNamespace = projections.filter((record) => record.namespace === namespace);
      const conflicting = await recallableMismatch(tenantId, namespace, profile, inNamespace);
      if (conflicting !== undefined) {
        throw new EvidenceProjectionCommitError(
          'embedding-profile-conflict',
          `Namespace "${namespace}" keeps recallable embedded record "${conflicting}" with another model or dimension than the ${profile.model}/${profile.dimensions} this commit writes.`,
        );
      }
      builder.require(key, stored?.raw ?? null);
      builder.put(key, encodeEmbeddingProfile(profile));
    }
  }

  /**
   * Turns the caller's read set into conditions. An entry whose key the batch
   * already conditions must agree with that condition; any entry whose key no
   * longer holds the bytes the caller saw means the state it decided on has
   * moved, and the commit is refused as a conflict instead of being retried: a
   * re-plan would only re-read the same changed key.
   */
  async function planReadSet(
    builder: BatchPlan,
    tenantId: string,
    readSet: NonNullable<EvidenceProjectionCommit['readSet']>,
  ): Promise<void> {
    for (const entry of readSet) {
      const seen = entry.value ?? null;
      const planned = builder.conditions.get(entry.key);
      const current = planned !== undefined ? planned : await reader.get(entry.key);
      const holds =
        seen === null ? current === null : current !== null && bytesEqual(current, seen);
      if (!holds) {
        throw new ProjectionRevisionConflictError(
          tenantId,
          undefined,
          [],
          `The state this commit was decided on changed at "${entry.key}"; nothing was written.`,
        );
      }
      if (planned === undefined) builder.require(entry.key, seen);
    }
  }

  async function planCommit(request: EvidenceProjectionCommit): Promise<{
    batch: PlannedBatch;
    result: EvidenceProjectionCommitResult;
  }> {
    const { evidence, projections } = validateCommit(request);
    const builder = new BatchPlan();
    const planned = await planEvidence(builder, request.tenantId, evidence);
    const projectionOutcomes = await planProjections(builder, projections, planned.appended);
    await planEmbeddingProfiles(builder, projections, projectionOutcomes);
    if (request.readSet !== undefined) {
      await planReadSet(builder, request.tenantId, request.readSet);
    }
    const { receipt } = request;
    const result = { evidence: planned.outcomes, projections: projectionOutcomes };
    if (receipt !== undefined) {
      planReceipt(builder, receipt);
      if ((await reader.get(receipt.key)) !== null) {
        // Refusing here, not losing the batch, keeps a lost receipt race from burning every attempt.
        throw new EvidenceProjectionCommitError(
          'receipt-exists',
          `A receipt is already stored under "${receipt.key}".`,
        );
      }
      const value = receipt.build(result);
      if (value.length === 0) {
        throw new EvidenceProjectionCommitError('invalid-commit', 'The commit receipt is empty.');
      }
      builder.require(receipt.key, null);
      builder.put(receipt.key, value);
    }
    return { batch: builder.toBatch(), result };
  }

  async function executeCommit(
    request: EvidenceProjectionCommit,
  ): Promise<EvidenceProjectionCommitResult> {
    for (let attempt = 1; attempt <= MAXIMUM_COMMIT_ATTEMPTS; attempt++) {
      const { batch, result } = await planCommit(request);
      if (batch.operations.length === 0) return result;
      assertWithinBatchCap(batch);
      if (await apply(batch)) return result;
    }
    const projections = request.projections ?? [];
    const namespaces = new Set(projections.map((record) => record.namespace));
    throw new ProjectionRevisionConflictError(
      request.tenantId,
      // One namespace when every lost projection shares it; none when they span several.
      namespaces.size === 1 ? [...namespaces][0] : undefined,
      projections.map((record) => record.id),
      'The commit lost its compare-and-swap; nothing was written.',
    );
  }

  async function getReceipt(key: string): Promise<Uint8Array | null> {
    return reader.get(key);
  }

  async function getEmbeddingProfile(
    tenantId: string,
    namespace: string,
  ): Promise<EmbeddingProfile | undefined> {
    const stored = await readEmbeddingProfile(tenantId, namespace);
    return stored?.profile;
  }

  async function getEvidence(tenantId: string, id: string): Promise<EvidenceRecord | undefined> {
    const stored = await readStoredEvidence(tenantId, id);
    return stored?.record;
  }

  async function getEvidenceSupersession(
    tenantId: string,
    id: string,
  ): Promise<EvidenceSupersession | undefined> {
    const raw = await reader.get(keys.supersession(tenantId, id));
    return raw === null ? undefined : decodeEvidenceSupersession(parseJson(raw, 'evidence'));
  }

  async function listEvidenceSupersessions(filter: {
    tenantId: string;
  }): Promise<ReadonlyMap<string, EvidenceSupersession>> {
    const prefix = keys.supersessionScan(filter.tenantId);
    const markers = new Map<string, EvidenceSupersession>();
    for (const key of await scan(prefix)) {
      const raw = await reader.get(key);
      if (raw === null) continue;
      markers.set(
        keys.idOfEvidenceKey(key, prefix),
        decodeEvidenceSupersession(parseJson(raw, 'evidence')),
      );
    }
    return markers;
  }

  async function listEvidence(filter: {
    tenantId: string;
    ownerId?: string;
    includeSuperseded?: boolean;
  }): Promise<EvidenceRecord[]> {
    const prefix = keys.evidenceScan(filter.tenantId);
    const markers =
      filter.includeSuperseded === true
        ? new Map<string, EvidenceSupersession>()
        : await listEvidenceSupersessions({ tenantId: filter.tenantId });
    const records: EvidenceRecord[] = [];
    for (const key of await scan(prefix)) {
      const stored = await readStoredEvidence(filter.tenantId, keys.idOfEvidenceKey(key, prefix));
      if (stored === undefined) continue;
      if (filter.ownerId !== undefined && stored.record.ownerId !== filter.ownerId) continue;
      if (markers.has(stored.record.id)) continue;
      records.push(stored.record);
    }
    return records;
  }

  async function getProjection(
    tenantId: string,
    namespace: string,
    id: string,
  ): Promise<EvidenceProjectionRecord | undefined> {
    const stored = await readStoredProjection(keys.current(tenantId, namespace, id), {
      tenantId,
      namespace,
      id,
    });
    return stored?.record;
  }

  async function getProjectionRevision(
    tenantId: string,
    namespace: string,
    id: string,
    revision: number,
  ): Promise<EvidenceProjectionRecord | undefined> {
    const stored = await readStoredProjection(keys.history(tenantId, namespace, id, revision), {
      tenantId,
      namespace,
      id,
      revision,
    });
    return stored?.record;
  }

  async function listProjections(filter: {
    tenantId: string;
    namespace: string;
    status?: readonly ProjectionStatus[];
  }): Promise<EvidenceProjectionRecord[]> {
    const prefix = keys.currentScan(filter.tenantId, filter.namespace);
    const records: EvidenceProjectionRecord[] = [];
    for (const key of await scan(prefix)) {
      const id = keys.idOfCurrentKey(key, prefix);
      const record = await getProjection(filter.tenantId, filter.namespace, id);
      if (record === undefined) continue;
      if (filter.status !== undefined && !filter.status.includes(record.status)) continue;
      records.push(record);
    }
    return records;
  }

  async function listProjectionHistory(
    tenantId: string,
    namespace: string,
    id: string,
  ): Promise<EvidenceProjectionRecord[]> {
    const prefix = keys.historyScan(tenantId, namespace, id);
    const history: EvidenceProjectionRecord[] = [];
    for (const key of await scan(prefix)) {
      const revision = keys.revisionOfHistoryKey(key, prefix);
      const record = await getProjectionRevision(tenantId, namespace, id, revision);
      if (record !== undefined) history.push(record);
    }
    return history;
  }

  const rawReads: EvidenceProjectionRawReads = {
    async evidence(tenantId, id) {
      const stored = await readStoredEvidence(tenantId, id);
      return { key: keys.evidence(tenantId, id), raw: stored?.raw, record: stored?.record };
    },
    async evidenceSupersession(tenantId, id) {
      const key = keys.supersession(tenantId, id);
      const raw = await reader.get(key);
      if (raw === null) return { key, raw: undefined, record: undefined };
      return { key, raw, record: decodeEvidenceSupersession(parseJson(raw, 'evidence')) };
    },
    async projection(tenantId, namespace, id) {
      const key = keys.current(tenantId, namespace, id);
      const stored = await readStoredProjection(key, { tenantId, namespace, id });
      return { key, raw: stored?.raw, record: stored?.record };
    },
    async projectionRevision(tenantId, namespace, id, revision) {
      const key = keys.history(tenantId, namespace, id, revision);
      const stored = await readStoredProjection(key, { tenantId, namespace, id, revision });
      return { key, raw: stored?.raw, record: stored?.record };
    },
  };

  return {
    [RAW_READS]: rawReads,
    commit: executeCommit,
    getReceipt,
    getEmbeddingProfile,
    async appendEvidence(record) {
      const result = await executeCommit({ tenantId: record.tenantId, evidence: [record] });
      return result.evidence[0]!.outcome;
    },
    async writeProjectionRevision(record) {
      const result = await executeCommit({ tenantId: record.tenantId, projections: [record] });
      return result.projections[0]!.outcome;
    },
    getEvidence,
    getEvidenceSupersession,
    listEvidenceSupersessions,
    listEvidence,
    getProjection,
    getProjectionRevision,
    listProjections,
    listProjectionHistory,
  };
}
