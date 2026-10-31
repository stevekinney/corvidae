import { cosineSimilarity } from 'armorer';

import type { GovernanceContext, ResolvedRecord } from './governance-context';
import type { ActiveEmbedding } from './governed-embedding';

/**
 * The vectors one recall compares: the active embedding it read once, and each candidate's vector
 * in that embedding's profile, read as candidates are scored. A candidate the profile holds no
 * vector for maps to `undefined`, and its semantic score and similarity are 0.
 */
export interface RecallVectors {
  readonly active: ActiveEmbedding;
  readonly byCandidate: Map<string, Float32Array | undefined>;
}

/** The key {@link RecallVectors.byCandidate} holds a record's vector under. */
export function candidateKey(candidate: ResolvedRecord): string {
  return `${candidate.scope.tenantId}\u0000${candidate.scope.namespace}\u0000${candidate.record.id}`;
}

/** Reads the profile's vectors for the candidates not read yet, one read per scope. */
export async function loadVectors(
  context: GovernanceContext,
  vectors: RecallVectors,
  candidates: readonly ResolvedRecord[],
): Promise<void> {
  const byScope = new Map<string, ResolvedRecord[]>();
  for (const candidate of candidates) {
    if (vectors.byCandidate.has(candidateKey(candidate))) continue;
    const scopeKey = `${candidate.scope.tenantId}\u0000${candidate.scope.namespace}`;
    const group = byScope.get(scopeKey) ?? [];
    group.push(candidate);
    byScope.set(scopeKey, group);
  }
  for (const group of byScope.values()) {
    const found = await context.embedding.vectors.getMany(
      vectors.active.profile,
      group[0]!.scope,
      group.map((candidate) => candidate.record.id),
    );
    for (const candidate of group) {
      vectors.byCandidate.set(candidateKey(candidate), found.get(candidate.record.id)?.vector);
    }
  }
}

/** Cosine similarity, or 0 when either vector is missing. */
export function similarity(
  left: Float32Array | undefined,
  right: Float32Array | undefined,
): number {
  return left === undefined || right === undefined ? 0 : cosineSimilarity(left, right);
}
