import { cosineSimilarity } from 'armorer';

import type { GovernanceContext } from './governance-context';
import type { MemoryRecallStageScores } from './governed-memory-types';
import { textScores } from './governed-reads';
import { embedOne } from './governed-writes';
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

/** The fused score: the weighted lexical and semantic scores, plus one for an exact match, scaled by retrieval weight. */
function fuse(plan: MemoryRetrievalPlan, scores: Omit<MemoryRecallStageScores, 'fused'>): number {
  const lexical = plan.stages.includes('exact-lexical');
  const semantic = plan.stages.includes('semantic');
  if (!plan.stages.includes('rank-fusion')) {
    return semantic ? scores.semantic : scores.lexical + scores.exact;
  }
  if (lexical && semantic) {
    return VECTOR_WEIGHT * scores.semantic + TEXT_WEIGHT * scores.lexical + scores.exact;
  }
  return semantic ? scores.semantic : scores.lexical + scores.exact;
}

/**
 * Scores candidates that already passed every policy filter. `exact-lexical`
 * contributes BM25 (or the configured text-search provider) and an exact
 * identifier or phrase match; `semantic` contributes cosine similarity to the
 * embedded query; `rank-fusion` combines them. Without fusion the plan's one
 * scoring stage ranks alone.
 */
export async function scoreCandidates(
  context: GovernanceContext,
  plan: MemoryRetrievalPlan,
  query: string,
  candidates: readonly RecallCandidate[],
): Promise<ScoringPass> {
  if (candidates.length === 0) return { ranked: [], cost: 0 };
  const lexicalStage = plan.stages.includes('exact-lexical');
  const semanticStage = plan.stages.includes('semantic');
  const queryVector = semanticStage ? await embedOne(context, query) : undefined;
  const lexical = lexicalStage ? await textScores(context, query, candidates) : [];
  const ranked = candidates.map((candidate, index) => {
    const partial = {
      exact: lexicalStage ? exactMatch(query, candidate) : 0,
      lexical: lexical[index] ?? 0,
      semantic:
        queryVector === undefined ? 0 : cosineSimilarity(queryVector, candidate.record.vector),
    };
    const fused = fuse(plan, partial) * candidate.read.governance.retrievalWeight;
    return { candidate, scores: { ...partial, fused } };
  });
  return {
    ranked: ranked.toSorted((left, right) => right.scores.fused - left.scores.fused),
    cost: semanticStage ? 1 : 0,
  };
}

/** Cosine similarity between two candidates' stored vectors. */
export function candidateSimilarity(left: RecallCandidate, right: RecallCandidate): number {
  return cosineSimilarity(left.record.vector, right.record.vector);
}
