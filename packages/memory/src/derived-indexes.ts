import { sha256HexSync } from '@lostgradient/cryptography';
import { cosineSimilarity, type EmbeddingVectorLike } from 'armorer';

import type { EvidenceProjectionRecord } from './evidence-projection-schema';
import { projectionText } from './evidence-projection-schema';
import type { EvidenceProjectionStorage } from './evidence-projection-storage';
import {
  type EvidenceRecord,
  type EvidenceSupersession,
  MemoryEvidenceValidationError,
} from './evidence-schema';
import type { MemoryAuthority } from './governance/authority';
import { decideMemoryAccess } from './governance/predicate';
import { computeBM25Scores } from './text-search';

/**
 * The five retrieval indexes: lexical, vector, temporal, entity, and graph.
 * Each is a pure function of the evidence and projections it is given and
 * exists only as the output of {@link buildDerivedIndexes}; none is ever
 * written to storage. Dropping one and building it again from the same inputs
 * yields the same `inputFingerprint`, `entryCount`, and query results.
 */

/**
 * One retrieval hit. `rawScore` is the relevance the hit was filtered on: the
 * cosine similarity (which a `threshold` is compared with) or the BM25 score,
 * before any status weight. `rankingScore` is what the hit was ordered by: the
 * raw score with the demotion weight applied (see {@link DEMOTED_SCORE_WEIGHT}).
 */
export interface ProjectionHit {
  readonly id: string;
  readonly revision: number;
  readonly rawScore: number;
  readonly rankingScore: number;
}

export interface IndexSummary {
  /** One digest over the admitted evidence and projections every index was built from. */
  readonly inputFingerprint: string;
  readonly entryCount: number;
}

export interface LexicalIndex extends IndexSummary {
  query(text: string, options: { limit: number }): ProjectionHit[];
}

export interface VectorIndex extends IndexSummary {
  /** The embedding model of every entry, or `undefined` when no projection is embedded. */
  readonly model: string | undefined;
  query(
    vector: EmbeddingVectorLike,
    options: { limit: number; threshold?: number },
  ): ProjectionHit[];
}

export interface TemporalIndex extends IndexSummary {
  /** Ids of projections valid at `asOf`, over the half-open interval `[validFrom, validUntil)`. */
  query(options: { asOf: number }): Array<{ id: string; revision: number }>;
}

export interface EntityIndex extends IndexSummary {
  /** Ids of projections that name `entity` (a fact's entity or a preference's subject). */
  query(entity: string): string[];
}

export type GraphEdgeKind =
  | 'lineage'
  | 'evidence-supersession'
  | 'projection-supersession'
  | 'projection-demotion'
  | 'covers';

/** A node is `evidence:<id>` or `projection:<id>`, so the two id spaces never collide. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: GraphEdgeKind;
}

export interface GraphIndex extends IndexSummary {
  query(options: { from: string } | { to: string }): GraphEdge[];
}

export interface DerivedIndexes {
  readonly inputFingerprint: string;
  readonly lexical: LexicalIndex;
  readonly vector: VectorIndex;
  readonly temporal: TemporalIndex;
  readonly entity: EntityIndex;
  readonly graph: GraphIndex;
}

export interface BuildDerivedIndexesInput {
  readonly evidence: readonly EvidenceRecord[];
  readonly supersessions: ReadonlyMap<string, EvidenceSupersession>;
  readonly projections: readonly EvidenceProjectionRecord[];
  readonly authority: MemoryAuthority;
}

/** Why a set of embeddings cannot share one vector index. */
export class EmbeddingMismatchError extends Error {
  readonly code = 'embedding-mismatch';

  constructor(
    readonly reason: 'model' | 'dimension',
    message: string,
  ) {
    super(message);
    this.name = 'EmbeddingMismatchError';
  }
}

/**
 * The evidence, marker, and projection reads kept changing under concurrent
 * commits for every attempt. This is a liveness outcome of steady ingestion, not
 * corruption: callers must handle it, typically by trying again shortly.
 */
export class DerivedIndexConsistencyError extends Error {
  readonly code = 'inconsistent-read';

  constructor(readonly attempts: number) {
    super(
      `Evidence and projections changed during ${attempts} consecutive reads; the indexes were not built.`,
    );
    this.name = 'DerivedIndexConsistencyError';
  }
}

/**
 * How far a `demoted` projection is pushed down the ranking. A demoted
 * projection stays recallable: a relevance cutoff (the vector `threshold`) is
 * compared with the raw score, so demotion never hides a match. Only the order
 * changes, by one rule in both scored indexes:
 *
 * - `rankingScore` is `rawScore` for an active projection;
 * - for a demoted projection it is `rawScore * DEMOTED_SCORE_WEIGHT` when
 *   `rawScore` is positive, and `rawScore` unchanged otherwise;
 * - hits are ordered by `rankingScore` descending, then active before demoted,
 *   then by id.
 *
 * The rule is monotone in the raw score for each status, and a demoted
 * projection never outranks an active one with the same raw score. A ranking
 * score stays inside the range of its raw score (so cosine stays in [-1, 1]).
 * A non-positive raw score is not relevant enough for a weight to mean
 * anything, so it is left alone and only the tie-break demotes it.
 */
export const DEMOTED_SCORE_WEIGHT = 0.5;

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function compareProjections(
  left: EvidenceProjectionRecord,
  right: EvidenceProjectionRecord,
): number {
  return compareText(left.id, right.id) || left.revision - right.revision;
}

/** Digests are verified against every loaded evidence record, admitted or not, whoever is asking. */
function assertSourceDigests(
  evidence: readonly EvidenceRecord[],
  projections: readonly EvidenceProjectionRecord[],
): void {
  const digests = new Map(evidence.map((record) => [tenantQualified(record), record.digest]));
  for (const projection of projections) {
    for (const source of projection.sources) {
      const stored = digests.get(
        tenantQualified({ tenantId: projection.tenantId, id: source.evidenceId }),
      );
      if (stored !== undefined && stored !== source.digest) {
        throw new MemoryEvidenceValidationError(
          'digest-mismatch',
          'projection',
          `Projection "${projection.id}" records a digest for evidence "${source.evidenceId}" that differs from the stored evidence.`,
        );
      }
    }
  }
}

/** Evidence ids repeat across tenants, so every lookup by id is qualified by its tenant. */
function tenantQualified(record: { tenantId: string; id: string }): string {
  // A tuple, not a delimited string: ids may contain any character, so no delimiter is safe.
  return JSON.stringify([record.tenantId, record.id]);
}

/** Evidence the authority may `search`, whether or not a later record superseded it. */
function searchableEvidence(input: BuildDerivedIndexesInput): EvidenceRecord[] {
  return input.evidence
    .filter(
      (record) =>
        decideMemoryAccess(input.authority, 'search', {
          tenantId: record.tenantId,
          ownerId: record.ownerId,
          visibility: record.authorizationScope.visibility,
          sharedWith: record.authorizationScope.sharedWith,
          state: 'active',
          // The decoder rejected every inline record whose digest disagrees with its text, and a
          // managed asset's digest cannot be checked here, so stored evidence is intact by now.
          integrity: 'intact',
          pendingDerivation: false,
        }).allowed,
    )
    .toSorted((left, right) => compareText(left.id, right.id));
}

/** Projections of this tenant that rest only on evidence the authority may search, any status. */
function visibleProjections(
  projections: readonly EvidenceProjectionRecord[],
  searchable: ReadonlySet<string>,
  tenantId: string,
): EvidenceProjectionRecord[] {
  return projections
    .filter((record) => record.tenantId === tenantId)
    .filter((record) =>
      record.sources.every((source) =>
        searchable.has(tenantQualified({ tenantId: record.tenantId, id: source.evidenceId })),
      ),
    );
}

function admitProjections(
  visible: readonly EvidenceProjectionRecord[],
  admittedEvidence: ReadonlySet<string>,
): EvidenceProjectionRecord[] {
  return visible
    .filter((record) => record.status === 'active' || record.status === 'demoted')
    .filter((record) =>
      record.sources.every((source) =>
        admittedEvidence.has(tenantQualified({ tenantId: record.tenantId, id: source.evidenceId })),
      ),
    )
    .toSorted(compareProjections);
}

function fingerprintOf(
  evidence: readonly EvidenceRecord[],
  projections: readonly EvidenceProjectionRecord[],
): string {
  const input = {
    evidence: evidence.map((record) => [record.id, record.digest]),
    projections: projections.map((record) => [
      record.id,
      record.revision,
      record.status,
      record.sources.map((source) => source.digest).toSorted(compareText),
    ]),
  };
  return `sha256:${sha256HexSync(JSON.stringify(input))}`;
}

interface ScoredHit {
  readonly hit: ProjectionHit;
  readonly demoted: boolean;
}

function scored(record: EvidenceProjectionRecord, rawScore: number): ScoredHit {
  const demoted = record.status === 'demoted';
  const rankingScore = demoted && rawScore > 0 ? rawScore * DEMOTED_SCORE_WEIGHT : rawScore;
  return { hit: { id: record.id, revision: record.revision, rawScore, rankingScore }, demoted };
}

function rank(entries: readonly ScoredHit[], limit: number): ProjectionHit[] {
  return entries
    .toSorted(
      (left, right) =>
        right.hit.rankingScore - left.hit.rankingScore ||
        Number(left.demoted) - Number(right.demoted) ||
        compareText(left.hit.id, right.hit.id),
    )
    .slice(0, limit)
    .map((entry) => entry.hit);
}

function buildLexical(
  projections: readonly EvidenceProjectionRecord[],
  inputFingerprint: string,
): LexicalIndex {
  const documents = projections.map(projectionText);
  return {
    inputFingerprint,
    entryCount: projections.length,
    query(text, options) {
      const scores = computeBM25Scores(text, documents);
      const hits: ScoredHit[] = [];
      for (const [index, score] of scores) {
        const record = projections[index];
        if (record !== undefined && score > 0) hits.push(scored(record, score));
      }
      return rank(hits, options.limit);
    },
  };
}

function buildVector(
  projections: readonly EvidenceProjectionRecord[],
  inputFingerprint: string,
): VectorIndex {
  const embedded = projections.flatMap((record) =>
    record.embedding === undefined ? [] : [{ record, embedding: record.embedding }],
  );
  const model = embedded[0]?.embedding.model;
  const dimension = embedded[0]?.embedding.vector.length;
  for (const entry of embedded) {
    if (entry.embedding.model !== model) {
      throw new EmbeddingMismatchError(
        'model',
        `Projections in one namespace mix embedding models "${model}" and "${entry.embedding.model}"; rebuild them with one model.`,
      );
    }
    if (entry.embedding.vector.length !== dimension) {
      throw new EmbeddingMismatchError(
        'dimension',
        `Projection "${entry.record.id}" has a ${entry.embedding.vector.length}-dimensional embedding where the others have ${dimension}; rebuild them with one model.`,
      );
    }
  }
  return {
    inputFingerprint,
    entryCount: embedded.length,
    model,
    query(vector, options) {
      const hits = embedded.map((entry) =>
        scored(entry.record, cosineSimilarity(vector, entry.embedding.vector)),
      );
      // A threshold is a relevance cutoff on the raw similarity; demotion only reorders.
      const kept =
        options.threshold === undefined
          ? hits
          : hits.filter((entry) => entry.hit.rawScore >= options.threshold!);
      return rank(kept, options.limit);
    },
  };
}

function buildTemporal(
  projections: readonly EvidenceProjectionRecord[],
  inputFingerprint: string,
): TemporalIndex {
  const intervals = projections.toSorted(
    (left, right) =>
      left.validity.validFrom - right.validity.validFrom || compareProjections(left, right),
  );
  return {
    inputFingerprint,
    entryCount: intervals.length,
    query({ asOf }) {
      return intervals
        .filter(
          (record) =>
            record.validity.validFrom <= asOf &&
            (record.validity.validUntil === undefined || asOf < record.validity.validUntil),
        )
        .map((record) => ({ id: record.id, revision: record.revision }))
        .toSorted((left, right) => compareText(left.id, right.id));
    },
  };
}

function entitiesOf(record: EvidenceProjectionRecord): string[] {
  if (record.kind === 'fact') return record.payload.entities;
  if (record.kind === 'preference') return [record.payload.subject];
  return [];
}

function buildEntity(
  projections: readonly EvidenceProjectionRecord[],
  inputFingerprint: string,
): EntityIndex {
  const terms = new Map<string, Set<string>>();
  for (const record of projections) {
    for (const entity of entitiesOf(record)) {
      const ids = terms.get(entity) ?? new Set<string>();
      ids.add(record.id);
      terms.set(entity, ids);
    }
  }
  return {
    inputFingerprint,
    entryCount: terms.size,
    query: (entity) => [...(terms.get(entity) ?? [])].toSorted(compareText),
  };
}

/** What the authority may see: an edge is emitted only when both of its ends are in these sets. */
interface GraphVisibility {
  readonly tenantId: string;
  /** Evidence ids the authority may search, superseded or not. */
  readonly evidence: ReadonlySet<string>;
  /** Ids of projections that rest only on such evidence, whatever their status. */
  readonly projections: ReadonlySet<string>;
}

function edgesOf(
  evidence: readonly EvidenceRecord[],
  projections: readonly EvidenceProjectionRecord[],
  visibility: GraphVisibility,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const evidenceNode = (id: string): string => `evidence:${id}`;
  const projectionNode = (id: string): string => `projection:${id}`;
  const push = (edge: GraphEdge, visible: boolean): void => {
    if (visible) edges.push(edge);
  };
  const seesEvidence = (id: string): boolean =>
    visibility.evidence.has(tenantQualified({ tenantId: visibility.tenantId, id }));
  const seesProjection = (id: string): boolean => visibility.projections.has(id);
  for (const record of evidence) {
    for (const predecessor of record.supersedes ?? []) {
      push(
        {
          from: evidenceNode(record.id),
          to: evidenceNode(predecessor),
          kind: 'evidence-supersession',
        },
        seesEvidence(predecessor),
      );
    }
  }
  for (const record of projections) {
    const from = projectionNode(record.id);
    for (const source of record.sources) {
      edges.push({ from, to: evidenceNode(source.evidenceId), kind: 'lineage' });
    }
    const { transition } = record;
    if (transition.kind === 'created') {
      for (const predecessor of transition.supersedes ?? []) {
        push(
          { from, to: projectionNode(predecessor.id), kind: 'projection-supersession' },
          seesProjection(predecessor.id),
        );
      }
    }
    if (transition.kind === 'superseded') {
      push(
        { from, to: projectionNode(transition.supersededBy.id), kind: 'projection-supersession' },
        seesProjection(transition.supersededBy.id),
      );
    }
    if (transition.kind === 'demoted') {
      push(
        { from, to: projectionNode(transition.demotedBy.id), kind: 'projection-demotion' },
        seesProjection(transition.demotedBy.id),
      );
    }
    if (record.kind === 'summary') {
      for (const covered of record.payload.covers) {
        push({ from, to: projectionNode(covered.id), kind: 'covers' }, seesProjection(covered.id));
      }
    }
  }
  const unique = new Map(
    edges.map((edge) => [JSON.stringify([edge.kind, edge.from, edge.to]), edge]),
  );
  return [...unique.entries()]
    .toSorted(([left], [right]) => compareText(left, right))
    .map(([, edge]) => edge);
}

function buildGraph(
  evidence: readonly EvidenceRecord[],
  projections: readonly EvidenceProjectionRecord[],
  visibility: GraphVisibility,
  inputFingerprint: string,
): GraphIndex {
  const edges = edgesOf(evidence, projections, visibility);
  return {
    inputFingerprint,
    entryCount: edges.length,
    query: (selector) =>
      'from' in selector
        ? edges.filter((edge) => edge.from === selector.from)
        : edges.filter((edge) => edge.to === selector.to),
  };
}

/**
 * Builds every index from authorized, active evidence and the projections that
 * rest on it. Pure: the same inputs always give the same fingerprints.
 *
 * Admission, in order:
 * - a projection whose source digest disagrees with the loaded evidence throws
 *   `digest-mismatch`, whatever its status and whoever is asking;
 * - superseded evidence is dropped, then evidence the authority may not
 *   `search` is dropped silently (the builder never reports what was withheld);
 * - a projection is admitted when it is `active` or `demoted` and every one of
 *   its sources is admitted evidence, so a projection whose evidence was
 *   superseded, deleted, or is not this authority's to see vanishes from
 *   retrieval without an error.
 *
 * A graph edge is emitted only when both of its ends are visible to the
 * authority: evidence it may search (superseded or not, so a correction can be
 * traced back to what it replaced) and projections that rest only on such
 * evidence (whatever their status). An edge never names an id the authority
 * cannot search.
 */
export function buildDerivedIndexes(input: BuildDerivedIndexesInput): DerivedIndexes {
  assertSourceDigests(input.evidence, input.projections);
  const searchable = searchableEvidence(input);
  const searchableIds = new Set(searchable.map(tenantQualified));
  const evidence = searchable.filter((record) => !input.supersessions.has(record.id));
  const visible = visibleProjections(input.projections, searchableIds, input.authority.tenantId);
  const projections = admitProjections(visible, new Set(evidence.map(tenantQualified)));
  const inputFingerprint = fingerprintOf(evidence, projections);
  const visibility: GraphVisibility = {
    tenantId: input.authority.tenantId,
    evidence: searchableIds,
    projections: new Set(visible.map((record) => record.id)),
  };
  return {
    inputFingerprint,
    lexical: buildLexical(projections, inputFingerprint),
    vector: buildVector(projections, inputFingerprint),
    temporal: buildTemporal(projections, inputFingerprint),
    entity: buildEntity(projections, inputFingerprint),
    graph: buildGraph(evidence, projections, visibility, inputFingerprint),
  };
}

/** A read set is taken at most this many times, each time twice, before giving up. */
const MAXIMUM_READ_ATTEMPTS = 3;

export interface StorageRead {
  readonly evidence: EvidenceRecord[];
  readonly supersessions: ReadonlyMap<string, EvidenceSupersession>;
  readonly projections: EvidenceProjectionRecord[];
}

/** The three reads in a fixed order: evidence first, then markers, then projections. */
async function readOnce(
  storage: EvidenceProjectionStorage,
  tenantId: string,
  namespace: string,
): Promise<StorageRead> {
  const evidence = await storage.listEvidence({ tenantId, includeSuperseded: true });
  const supersessions = await storage.listEvidenceSupersessions({ tenantId });
  const projections = await storage.listProjections({ tenantId, namespace });
  return { evidence, supersessions, projections };
}

function signatureOf(read: StorageRead): string {
  return JSON.stringify([
    read.evidence.map((record) => JSON.stringify([record.id, record.digest])).toSorted(compareText),
    [...read.supersessions.keys()].toSorted(compareText),
    read.projections.map((record) => `${record.id}@${record.revision}`).toSorted(compareText),
  ]);
}

/**
 * Reads the tenant's evidence and one namespace's projections from storage,
 * then builds.
 *
 * The three reads are not one snapshot, and a correction commits evidence, a
 * marker, and projections atomically: a read that straddled it could see the
 * old evidence with the new projections, and drop both the old projection and
 * its replacement. So the reads are done twice, in the same order (evidence,
 * markers, projections), and the build runs only when both passes return the
 * same signature.
 *
 * Why equal signatures mean a consistent read. Each signature element names
 * immutable content: an evidence id with its digest, a marker's id, a
 * projection id with its revision. Stored state therefore only grows, and a
 * component that read the same in both passes did not change between its two
 * reads. The passes are sequential, so the span from each component's first
 * read to its second contains the span from the first pass's projection read
 * to the second pass's evidence read. At any instant in that span the stored
 * state was exactly what was read.
 *
 * That argument rests on three premises, and breaks without any of them:
 * - no key is ever deleted and then written again with different bytes under
 *   the same name, so physical deletion of evidence (the governance and
 *   deletion work) must either keep a tombstone or change what a signature
 *   names;
 * - every signature element names immutable content, so a signature element
 *   cannot stay equal while its content changes;
 * - reads of one key are linearizable, which `Storage` provides.
 *
 * It does not need every commit to add evidence: a commit that adds only
 * projection revisions changes the projection component, which the signature
 * covers.
 *
 * The read is repeated up to three times. Under steady ingestion, where every
 * pass finds something new, it can fail with {@link DerivedIndexConsistencyError}.
 * That is a liveness outcome, not corruption: nothing is wrong with storage,
 * and callers should treat it as "try again shortly" and handle it. This adds
 * no persisted state.
 */
export async function rebuildDerivedIndexes(options: {
  readonly storage: EvidenceProjectionStorage;
  readonly tenantId: string;
  readonly namespace: string;
  readonly authority: MemoryAuthority;
}): Promise<DerivedIndexes> {
  const { storage, tenantId, namespace, authority } = options;
  return buildDerivedIndexes({
    ...(await readConsistently(storage, tenantId, namespace)),
    authority,
  });
}

/**
 * The tenant's evidence and markers and one namespace's projections, every
 * status, as one consistent read: the double read {@link rebuildDerivedIndexes}
 * describes, for a caller that filters the read before it builds.
 */
export async function readConsistently(
  storage: EvidenceProjectionStorage,
  tenantId: string,
  namespace: string,
): Promise<StorageRead> {
  for (let attempt = 1; attempt <= MAXIMUM_READ_ATTEMPTS; attempt++) {
    const first = await readOnce(storage, tenantId, namespace);
    const second = await readOnce(storage, tenantId, namespace);
    if (signatureOf(first) === signatureOf(second)) return second;
  }
  throw new DerivedIndexConsistencyError(MAXIMUM_READ_ATTEMPTS);
}
