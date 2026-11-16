import { MemoryVectorDimensionError } from '../memory-vector-store';
import type { GovernanceContext } from './governance-context';
import type { MemoryRecallStageScores } from './governed-memory-types';
import { textScores } from './governed-reads';
import { embedOne } from './governed-writes';
import { candidateKey, loadVectors, type RecallVectors, similarity } from './profile-vectors';
import type { RecallCandidate } from './recall-candidates';
import type { MemoryRetrievalPlan } from './retrieval-plan';

const VECTOR_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;

/** A candidate with its scores from one scoring pass. */
export interface ScoredCandidate {
  readonly candidate: RecallCandidate;
  readonly scores: MemoryRecallStageScores;
}

/** One scoring pass: the candidates in fused-score order, and how many embedder calls it made. */
export interface ScoringPass {
  readonly ranked: readonly ScoredCandidate[];
  readonly cost: number;
  /**
   * Whether the active embedder failed on this pass's query (it threw, or did not answer within its
   * bound), so the pass scored by text alone. A recall asks a failed embedder no more.
   */
  readonly embedderFailed: boolean;
}

/**
 * Whether `query` names `candidate` exactly: its record identifier appears as a
 * token of the query, or the whole query appears verbatim in its content.
 */
function exactMatch(query: string, candidate: RecallCandidate): number {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return 0;
  if (normalized.split(/\s+/).includes(candidate.record.id.toLowerCase())) return 1;
  return candidate.record.content.toLowerCase().includes(normalized) ? 1 : 0;
}

/**
 * The fused score: the weighted lexical and semantic scores, plus one for an exact match. Without
 * vectors (`semantic` false: the plan selects no semantic stage, or the active embedder is
 * unavailable) the lexical and exact scores rank alone, as they do for a lexical-only plan.
 */
function fuse(
  plan: MemoryRetrievalPlan,
  semantic: boolean,
  scores: Omit<MemoryRecallStageScores, 'fused'>,
): number {
  if (!semantic) return scores.lexical + scores.exact;
  if (plan.stages.includes('exact-lexical') && plan.stages.includes('rank-fusion')) {
    return VECTOR_WEIGHT * scores.semantic + TEXT_WEIGHT * scores.lexical + scores.exact;
  }
  return scores.semantic;
}

/**
 * Scores candidates that already passed every policy filter. `exact-lexical`
 * contributes BM25 (or the configured text-search provider) and an exact
 * identifier or phrase match; `semantic` contributes cosine similarity to the
 * embedded query; `rank-fusion` combines them. Without fusion the plan's one
 * scoring stage ranks alone. With no `vectors` for a plan that selects
 * `semantic`, the active embedder is unavailable: the candidates are scored
 * as `exact-lexical` would score them, and the pass costs no embedder call. When
 * the embedder is available but fails on the query (it throws, or does not answer
 * within its bound) the pass scores the same way, reports `embedderFailed`, and
 * costs the one call it made. A vector the profile refuses (a wrong dimension, a
 * non-finite entry), and a recall the caller cancelled, still throw.
 */
export async function scoreCandidates(
  context: GovernanceContext,
  vectors: RecallVectors | undefined,
  plan: MemoryRetrievalPlan,
  query: string,
  candidates: readonly RecallCandidate[],
  options: {
    /** The recall's own signal: the query's embed ends when it aborts, and the recall is canceled. */
    readonly signal?: AbortSignal;
    /**
     * How long the query's embed may take, at most, so the recall keeps budget to admit with
     * afterwards. A bound and not a signal: running out is an embedder that did not answer, never
     * a caller that gave up.
     */
    readonly embedTimeoutMilliseconds?: number;
  } = {},
): Promise<ScoringPass> {
  const { signal, embedTimeoutMilliseconds } = options;
  if (candidates.length === 0) return { ranked: [], cost: 0, embedderFailed: false };
  const wantsSemantic = plan.stages.includes('semantic') && vectors !== undefined;
  if (vectors !== undefined) await loadVectors(context, vectors, candidates);
  let queryVector: Float32Array | undefined;
  let embedderFailed = false;
  if (wantsSemantic) {
    try {
      queryVector = await embedOne(vectors.active, query, {
        ...(signal === undefined ? {} : { signal }),
        ...(embedTimeoutMilliseconds === undefined
          ? {}
          : { timeoutMilliseconds: embedTimeoutMilliseconds }),
      });
    } catch (error) {
      // A vector the profile refuses, and the caller giving up, are not an outage: the first still
      // fails the recall closed, and the second ends it as canceled (the caller reads its signal).
      if (error instanceof MemoryVectorDimensionError || signal?.aborted === true) throw error;
      // The embedder threw, or did not answer within its bound: the pass scores by text alone.
      embedderFailed = true;
    }
  }
  const semanticStage = wantsSemantic && !embedderFailed;
  // A plan that selects `semantic` falls back to text while the active embedder is unavailable or
  // has failed.
  const lexicalStage = plan.stages.includes('exact-lexical') || !semanticStage;
  const lexical = lexicalStage ? await textScores(context, query, candidates) : [];
  const ranked = candidates.map((candidate, index) => {
    const partial = {
      exact: lexicalStage ? exactMatch(query, candidate) : 0,
      lexical: lexical[index] ?? 0,
      semantic: similarity(queryVector, vectors?.byCandidate.get(candidateKey(candidate))),
    };
    const fused = fuse(plan, semanticStage, partial) * candidate.read.governance.retrievalWeight;
    return { candidate, scores: { ...partial, fused } };
  });
  return {
    ranked: ranked.toSorted((left, right) => right.scores.fused - left.scores.fused),
    // An embed that failed was still asked for, so it costs what one that answered does.
    cost: wantsSemantic ? 1 : 0,
    embedderFailed,
  };
}

/** Cosine similarity between two scored candidates' vectors in the recall's profile, 0 when either has none. */
export function candidateSimilarity(
  vectors: RecallVectors | undefined,
  left: RecallCandidate,
  right: RecallCandidate,
): number {
  return similarity(
    vectors?.byCandidate.get(candidateKey(left)),
    vectors?.byCandidate.get(candidateKey(right)),
  );
}
