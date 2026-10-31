import { computeBM25Scores } from '../text-search';
import type { MemoryAuthority, MemoryOperation } from './authority';
import {
  authorizeLocated,
  type GovernanceContext,
  ownPrivateResource,
  type ResolvedRecord,
  resourceOf,
  type TenantScope,
} from './governance-context';
import type {
  GovernedListOptions,
  GovernedSearchHit,
  GovernedSearchOptions,
  MemoryExportResult,
  MemoryRecordLocator,
} from './governed-memory-types';
import { embedOne } from './governed-writes';
import { decideMemoryAccess, type MemoryRedaction } from './predicate';
import { candidateKey, loadVectors, type RecallVectors, similarity } from './profile-vectors';
import {
  type GovernedMemoryRecord,
  projectRecord,
  readRecordGovernance,
} from './record-governance';

const VECTOR_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;

interface Candidate extends ResolvedRecord {
  readonly redaction: MemoryRedaction;
}

/** The caller's own collection scopes for a visibility: never another owner's partition or tenant. */
export function scopesFor(
  context: GovernanceContext,
  authority: MemoryAuthority,
  collection: string,
  visibility: 'private' | 'shared' | 'all',
): TenantScope[] {
  const scopes: TenantScope[] = [];
  if (visibility !== 'shared') {
    scopes.push(context.scope(authority.tenantId, 'private', authority.ownerId, collection));
  }
  if (visibility !== 'private') {
    scopes.push(context.scope(authority.tenantId, 'shared', authority.ownerId, collection));
  }
  return scopes;
}

/**
 * Every record in the caller's collection scopes that the shared predicate lets
 * this authority see. The scopes are derived from the authority, so a record in
 * another owner's partition or tenant never becomes a candidate; the predicate
 * then re-checks each record's persisted governance.
 */
async function candidatesFor(
  context: GovernanceContext,
  authority: MemoryAuthority,
  operation: MemoryOperation,
  options: { collection: string; visibility?: 'private' | 'shared' | 'all' },
): Promise<Candidate[]> {
  if (options.collection.length === 0) return [];
  const candidates: Candidate[] = [];
  for (const scope of scopesFor(
    context,
    authority,
    options.collection,
    options.visibility ?? 'all',
  )) {
    for (const record of await context.storage.list(scope)) {
      const read = readRecordGovernance(record);
      if (read === undefined) continue;
      const decision = decideMemoryAccess(
        authority,
        operation,
        resourceOf({ record, read, scope }),
      );
      if (decision.allowed) candidates.push({ record, read, scope, redaction: decision.redaction });
    }
  }
  return candidates;
}

function retrievable(candidate: Candidate): boolean {
  const { governance } = candidate.read;
  return (
    governance.state === 'active' &&
    !governance.indexInvalidated &&
    governance.invalidatedAt === undefined
  );
}

/** Lexical scores in candidate order: the configured text-search provider's, or BM25 normalized to [0, 1). */
export async function textScores(
  context: GovernanceContext,
  query: string,
  candidates: readonly Candidate[],
): Promise<number[]> {
  const provider = context.textSearchProvider;
  if (provider !== undefined) {
    const byNamespace = new Map<string, Map<string, number>>();
    for (const candidate of candidates) {
      const namespace = candidate.scope.namespace;
      if (!byNamespace.has(namespace))
        byNamespace.set(namespace, await provider.search(query, namespace));
    }
    return candidates.map(
      (candidate) => byNamespace.get(candidate.scope.namespace)!.get(candidate.record.id) ?? 0,
    );
  }
  const raw = computeBM25Scores(
    query,
    candidates.map((candidate) => candidate.record.content),
  );
  return candidates.map((_candidate, index) => {
    const score = raw.get(index) ?? 0;
    return score / (1 + score);
  });
}

async function rank(
  context: GovernanceContext,
  query: string,
  candidates: readonly Candidate[],
): Promise<{ candidate: Candidate; score: number }[]> {
  if (candidates.length === 0) return [];
  // While the active embedder is unavailable, the search ranks by text alone.
  const { embedding } = await context.embedding.activeIfAvailable();
  const vectors: RecallVectors | undefined =
    embedding === undefined ? undefined : { active: embedding, byCandidate: new Map() };
  let queryVector: Float32Array | undefined;
  if (vectors !== undefined) {
    await loadVectors(context, vectors, candidates);
    queryVector = await embedOne(vectors.active, query);
  }
  const texts = await textScores(context, query, candidates);
  return candidates
    .map((candidate, index) => ({
      candidate,
      score:
        (VECTOR_WEIGHT *
          similarity(queryVector, vectors?.byCandidate.get(candidateKey(candidate))) +
          TEXT_WEIGHT * texts[index]!) *
        candidate.read.governance.retrievalWeight,
    }))
    .toSorted((left, right) => right.score - left.score);
}

async function recordRead(
  context: GovernanceContext,
  authority: MemoryAuthority,
  operation: MemoryOperation,
  operationId: string,
  recordIds: readonly string[],
): Promise<void> {
  await context.recordEvent({
    tenantId: authority.tenantId,
    type: 'memory.read',
    outcome: 'allowed',
    attribution: context.attribution(authority, operationId),
    recordIds,
    details: { operation, count: recordIds.length },
  });
}

/** Whether the caller holds the capability for `operation` at all, recorded as an authorization decision. */
export async function capabilityAllowed(
  context: GovernanceContext,
  authority: MemoryAuthority,
  operation: MemoryOperation,
  operationId: string,
): Promise<boolean> {
  const outcome = await context.authorize(authority, operation, ownPrivateResource(authority), {
    operationId,
    recordIds: [],
  });
  return outcome.allowed;
}

export async function getRecord(
  context: GovernanceContext,
  authority: MemoryAuthority,
  locator: MemoryRecordLocator,
): Promise<GovernedMemoryRecord | undefined> {
  const operationId = context.operationId();
  const located = await authorizeLocated(context, authority, 'get', locator, operationId);
  if (!('resolved' in located)) return undefined;
  await recordRead(context, authority, 'get', operationId, [locator.id]);
  return projectRecord(located.resolved.record, located.resolved.read, located.redaction);
}

export async function listRecords(
  context: GovernanceContext,
  authority: MemoryAuthority,
  options: GovernedListOptions,
): Promise<GovernedMemoryRecord[]> {
  const operationId = context.operationId();
  if (!(await capabilityAllowed(context, authority, 'list', operationId))) return [];
  // A record taken out of active use by supersession or consolidation stays stored for history
  // and stays readable by `get`, but a listing shows it only to a privileged (`memory:inspect`)
  // caller, as it does a quarantined or revoked one (COR-1546).
  const readable = await candidatesFor(context, authority, 'list', options);
  const listed = readable.filter(
    (candidate) =>
      candidate.redaction === 'privileged' || candidate.read.governance.invalidatedAt === undefined,
  );
  const candidates = listed.toSorted(
    (left, right) => right.record.createdAt - left.record.createdAt,
  );
  const offset = options.offset ?? 0;
  const page = candidates.slice(offset, offset + (options.limit ?? 100));
  await recordRead(
    context,
    authority,
    'list',
    operationId,
    page.map((candidate) => candidate.record.id),
  );
  return page.map((candidate) =>
    projectRecord(candidate.record, candidate.read, candidate.redaction),
  );
}

export async function searchRecords(
  context: GovernanceContext,
  authority: MemoryAuthority,
  query: string,
  options: GovernedSearchOptions,
): Promise<GovernedSearchHit[]> {
  const operationId = context.operationId();
  if (!(await capabilityAllowed(context, authority, 'search', operationId))) return [];
  const searchable = await candidatesFor(context, authority, 'search', options);
  const candidates = searchable.filter(
    (candidate) =>
      retrievable(candidate) &&
      (options.memoryClass === undefined ||
        candidate.read.governance.memoryClass === options.memoryClass),
  );
  const ranked = await rank(context, query, candidates);
  const hits = ranked.slice(0, options.limit ?? 10);
  await recordRead(
    context,
    authority,
    'search',
    operationId,
    hits.map((hit) => hit.candidate.record.id),
  );
  return hits.map((hit) => ({
    record: projectRecord(hit.candidate.record, hit.candidate.read, hit.candidate.redaction),
    score: hit.score,
  }));
}

/** Evictions are keyed by owner as well as context, so one owner cannot suppress another's recall. */
export function evictionContext(authority: MemoryAuthority, contextId: string): string {
  return JSON.stringify([authority.ownerId, contextId]);
}

/** Whether a deletion has removed `candidate` or claimed it, read as it is stored now. */
async function deletionReached(context: GovernanceContext, candidate: Candidate): Promise<boolean> {
  const current = await context.load(candidate.scope.tenantId, {
    id: candidate.record.id,
    namespace: candidate.scope.namespace,
  });
  return current === undefined || current.read.governance.deletionRequestedAt !== undefined;
}

/**
 * Exports the records the caller may read and stores a manifest of them. Once
 * the manifest is stored, every exported record is read again: one that a
 * deletion removed or claimed meanwhile is scrubbed from the manifest and left
 * out of the export. A deletion claims its records before its synchronous lane
 * and scrubs exports after it, so each deletion running alongside is either
 * seen here or finds this manifest when it scrubs.
 */
export async function exportRecords(
  context: GovernanceContext,
  authority: MemoryAuthority,
  options: GovernedListOptions,
): Promise<MemoryExportResult> {
  const operationId = context.operationId();
  if (!(await capabilityAllowed(context, authority, 'export', operationId))) {
    return { operationId, status: 'denied', records: [] };
  }
  const candidates = await candidatesFor(context, authority, 'export', options);
  const exportId = context.runtime.identifiers.next('memory-export');
  await context.ledger.putExport({
    version: 1,
    exportId,
    tenantId: authority.tenantId,
    ownerId: authority.ownerId,
    exportedBy: context.attribution(authority, operationId),
    recordIds: candidates.map((candidate) => candidate.record.id),
    removedRecordIds: [],
    createdAt: context.now(),
    revoked: false,
  });
  const exported: Candidate[] = [];
  const removed: string[] = [];
  for (const candidate of candidates) {
    if (await deletionReached(context, candidate)) removed.push(candidate.record.id);
    else exported.push(candidate);
  }
  if (removed.length > 0) await context.ledger.scrubExport(authority.tenantId, exportId, removed);
  const recordIds = exported.map((candidate) => candidate.record.id);
  await context.recordEvent({
    tenantId: authority.tenantId,
    type: 'memory.exported',
    outcome: 'applied',
    attribution: context.attribution(authority, operationId),
    recordIds,
    details: { exportId },
  });
  return {
    operationId,
    status: 'applied',
    exportId,
    recordIds,
    records: exported.map((candidate) =>
      projectRecord(candidate.record, candidate.read, candidate.redaction),
    ),
  };
}
