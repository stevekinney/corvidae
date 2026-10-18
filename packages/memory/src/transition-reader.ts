import type { EvidenceProjectionRecord } from './evidence-projection-schema';
import type { EvidenceProjectionStorage } from './evidence-projection-storage';
import type { EvidenceRecord } from './evidence-schema';

/**
 * The reads one submission makes, memoized so the validator, the plan, and the
 * receipt agree about what the store held when validation ran. The commit's own
 * conditions guard against the store having moved since, so a stale read costs a
 * `conflicted` outcome, never a wrong write.
 */
export interface TransitionReader {
  evidence(id: string): Promise<EvidenceRecord | undefined>;
  /** Whether a supersession marker exists for the evidence. */
  isSuperseded(id: string): Promise<boolean>;
  /** The current revision. */
  projection(namespace: string, id: string): Promise<EvidenceProjectionRecord | undefined>;
  projectionRevision(
    namespace: string,
    id: string,
    revision: number,
  ): Promise<EvidenceProjectionRecord | undefined>;
  /** Current revisions that stay recallable: `active` or `demoted`. */
  recallable(namespace: string): Promise<EvidenceProjectionRecord[]>;
}

function memoize<Value>(
  cache: Map<string, Promise<Value>>,
  key: string,
  load: () => Promise<Value>,
) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const loading = load();
  cache.set(key, loading);
  return loading;
}

export function createTransitionReader(
  storage: Pick<
    EvidenceProjectionStorage,
    | 'getEvidence'
    | 'getEvidenceSupersession'
    | 'getProjection'
    | 'getProjectionRevision'
    | 'listProjections'
  >,
  tenantId: string,
): TransitionReader {
  const evidence = new Map<string, Promise<EvidenceRecord | undefined>>();
  const superseded = new Map<string, Promise<boolean>>();
  const projections = new Map<string, Promise<EvidenceProjectionRecord | undefined>>();
  const revisions = new Map<string, Promise<EvidenceProjectionRecord | undefined>>();
  const recallable = new Map<string, Promise<EvidenceProjectionRecord[]>>();
  const address = (...parts: Array<string | number>): string => JSON.stringify(parts);
  return {
    evidence: (id) => memoize(evidence, id, () => storage.getEvidence(tenantId, id)),
    isSuperseded: (id) =>
      memoize(superseded, id, async () => {
        return (await storage.getEvidenceSupersession(tenantId, id)) !== undefined;
      }),
    projection: (namespace, id) =>
      memoize(projections, address(namespace, id), () =>
        storage.getProjection(tenantId, namespace, id),
      ),
    projectionRevision: (namespace, id, revision) =>
      memoize(revisions, address(namespace, id, revision), () =>
        storage.getProjectionRevision(tenantId, namespace, id, revision),
      ),
    recallable: (namespace) =>
      memoize(recallable, namespace, () =>
        storage.listProjections({ tenantId, namespace, status: ['active', 'demoted'] }),
      ),
  };
}
