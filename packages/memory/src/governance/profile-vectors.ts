import { cosineSimilarity } from 'armorer';

import type {
  MemoryEmbeddingProfile,
  MemoryVectorReference,
  StoredMemoryVector,
} from '../memory-vector-store';
import type { GovernanceContext, ResolvedRecord } from './governance-context';
import { type ActiveEmbedding, cachingEmbedders } from './governed-embedding';
import { digestContent } from './record-governance';

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

/**
 * Evicts `content`'s embedding from every registered embedder that caches content. An embed that
 * finds its record deleted calls it: the deletion's `caches` target may have run before the embed
 * put the content back in a cache, and that target is not run again.
 */
export async function evictCachedContent(
  context: GovernanceContext,
  content: string,
): Promise<void> {
  const digests = [digestContent(content)];
  for (const embedder of cachingEmbedders(context.embedding.registry)) {
    await embedder.evictContent(digests);
  }
}

/**
 * Stores a record's vector in `profile`, fenced against a deletion of the record running alongside.
 * Deletion removes the record, then its vectors from every profile. This writes the vector, then
 * reads the record: one still stored is deleted, if ever, after this write, and its deletion removes
 * the vector; one already gone may have been deleted before this write, so the vector is removed
 * here, and so is the embedding of `embedded`, the content just embedded for it, from any cache. The
 * record's content never changes in place, so only its existence is checked, not its `version`.
 */
export async function putRecordVector(
  context: GovernanceContext,
  profile: MemoryEmbeddingProfile,
  reference: MemoryVectorReference,
  entry: StoredMemoryVector,
  embedded?: string,
): Promise<void> {
  await context.embedding.vectors.put(profile, reference, entry);
  if ((await context.storage.get(reference.id, reference.scope)) !== undefined) return;
  await context.embedding.forget([reference]);
  if (embedded !== undefined) await evictCachedContent(context, embedded);
}

/** Copies the inline vectors of `scope`'s records that `profile` does not hold yet. */
async function copyScopeInlineVectors(
  context: GovernanceContext,
  profile: MemoryEmbeddingProfile,
  scope: Required<MemoryVectorReference['scope']>,
): Promise<void> {
  const stored = await context.storage.list(scope);
  const records = stored.filter((record) => record.vector.length === profile.dimension);
  const held = await context.embedding.vectors.getMany(
    profile,
    scope,
    records.map((record) => record.id),
  );
  for (const record of records) {
    if (held.has(record.id)) continue;
    await putRecordVector(
      context,
      profile,
      { id: record.id, scope },
      { version: record.version, vector: record.vector },
    );
  }
}

/**
 * Copies the vectors records held inline before COR-1898 into the profile memory starts with, once
 * per store. Those vectors were made by the embedder memory was built with, which is the initial
 * embedder now, so they belong to its generation-1 profile; a record's vector of any other length
 * is not one of them and is left. A record the profile already holds keeps its vector. A crash part
 * way leaves the store unmarked, and the next start copies what is still missing. When the active
 * profile is another, an embedding already replaced the initial one, and nothing is copied.
 */
export async function copyInlineVectors(context: GovernanceContext): Promise<void> {
  const { vectors, initialProfile } = context.embedding;
  if (await vectors.inlineVectorsCopied()) return;
  const profile = await vectors.activeProfile(initialProfile);
  const initial =
    profile.embedderId === initialProfile.embedderId &&
    profile.dimension === initialProfile.dimension &&
    profile.generation === initialProfile.generation;
  if (initial) {
    for (const scope of await context.ledger.listScopes()) {
      await copyScopeInlineVectors(context, profile, scope);
    }
  }
  await vectors.markInlineVectorsCopied();
}
