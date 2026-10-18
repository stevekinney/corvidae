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

export interface ProjectionHit {
  readonly id: string;
  readonly revision: number;
  readonly score: number;
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
  'lineage' | 'evidence-supersession' | 'projection-supersession' | 'covers';

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
  const digests = new Map(evidence.map((record) => [record.id, record.digest]));
  for (const projection of projections) {
    for (const source of projection.sources) {
      const stored = digests.get(source.evidenceId);
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

function admitEvidence(input: BuildDerivedIndexesInput): EvidenceRecord[] {
  return input.evidence
    .filter((record) => !input.supersessions.has(record.id))
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

function admitProjections(
  projections: readonly EvidenceProjectionRecord[],
  admittedEvidence: ReadonlySet<string>,
): EvidenceProjectionRecord[] {
  return projections
    .filter((record) => record.status === 'active' || record.status === 'demoted')
    .filter((record) => record.sources.every((source) => admittedEvidence.has(source.evidenceId)))
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

function byScoreThenId(left: ProjectionHit, right: ProjectionHit): number {
  return right.score - left.score || compareText(left.id, right.id);
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
      const hits: ProjectionHit[] = [];
      for (const [index, score] of scores) {
        const record = projections[index];
        if (record !== undefined && score > 0) {
          hits.push({ id: record.id, revision: record.revision, score });
        }
      }
      return hits.toSorted(byScoreThenId).slice(0, options.limit);
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
  for (const entry of embedded) {
    if (entry.embedding.model !== model) {
      throw new Error(
        `Projections in one namespace mix embedding models "${model}" and "${entry.embedding.model}"; rebuild them with one model.`,
      );
    }
  }
  return {
    inputFingerprint,
    entryCount: embedded.length,
    model,
    query(vector, options) {
      const hits = embedded.map((entry): ProjectionHit => ({
        id: entry.record.id,
        revision: entry.record.revision,
        score: cosineSimilarity(vector, entry.embedding.vector),
      }));
      const kept =
        options.threshold === undefined
          ? hits
          : hits.filter((hit) => hit.score >= options.threshold!);
      return kept.toSorted(byScoreThenId).slice(0, options.limit);
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

function edgesOf(
  evidence: readonly EvidenceRecord[],
  projections: readonly EvidenceProjectionRecord[],
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const evidenceNode = (id: string): string => `evidence:${id}`;
  const projectionNode = (id: string): string => `projection:${id}`;
  for (const record of evidence) {
    for (const predecessor of record.supersedes ?? []) {
      edges.push({
        from: evidenceNode(record.id),
        to: evidenceNode(predecessor),
        kind: 'evidence-supersession',
      });
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
        edges.push({ from, to: projectionNode(predecessor.id), kind: 'projection-supersession' });
      }
    }
    if (transition.kind === 'superseded') {
      edges.push({
        from,
        to: projectionNode(transition.supersededBy.id),
        kind: 'projection-supersession',
      });
    }
    if (transition.kind === 'demoted') {
      edges.push({
        from,
        to: projectionNode(transition.demotedBy.id),
        kind: 'projection-supersession',
      });
    }
    if (record.kind === 'summary') {
      for (const covered of record.payload.covers) {
        edges.push({ from, to: projectionNode(covered.id), kind: 'covers' });
      }
    }
  }
  const unique = new Map(edges.map((edge) => [`${edge.kind}\0${edge.from}\0${edge.to}`, edge]));
  return [...unique.entries()]
    .toSorted(([left], [right]) => compareText(left, right))
    .map(([, edge]) => edge);
}

function buildGraph(
  evidence: readonly EvidenceRecord[],
  projections: readonly EvidenceProjectionRecord[],
  inputFingerprint: string,
): GraphIndex {
  const edges = edgesOf(evidence, projections);
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
 */
export function buildDerivedIndexes(input: BuildDerivedIndexesInput): DerivedIndexes {
  assertSourceDigests(input.evidence, input.projections);
  const evidence = admitEvidence(input);
  const projections = admitProjections(
    input.projections,
    new Set(evidence.map((record) => record.id)),
  );
  const inputFingerprint = fingerprintOf(evidence, projections);
  return {
    inputFingerprint,
    lexical: buildLexical(projections, inputFingerprint),
    vector: buildVector(projections, inputFingerprint),
    temporal: buildTemporal(projections, inputFingerprint),
    entity: buildEntity(projections, inputFingerprint),
    graph: buildGraph(evidence, projections, inputFingerprint),
  };
}

/** Reads the tenant's evidence and one namespace's projections from storage, then builds. */
export async function rebuildDerivedIndexes(options: {
  readonly storage: EvidenceProjectionStorage;
  readonly tenantId: string;
  readonly namespace: string;
  readonly authority: MemoryAuthority;
}): Promise<DerivedIndexes> {
  const { storage, tenantId, namespace, authority } = options;
  const [evidence, supersessions, projections] = await Promise.all([
    storage.listEvidence({ tenantId, includeSuperseded: true }),
    storage.listEvidenceSupersessions({ tenantId }),
    storage.listProjections({ tenantId, namespace }),
  ]);
  return buildDerivedIndexes({ evidence, supersessions, projections, authority });
}
