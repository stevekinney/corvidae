import type { EmbeddingProfile, EvidenceProjectionRecord } from './evidence-projection-schema';
import {
  type EvidenceProjectionRawReads,
  type EvidenceProjectionStorage,
  RAW_READS,
  type RawRead,
} from './evidence-projection-storage';
import type { EvidenceRecord } from './evidence-schema';

/** One key a submission read, and the raw bytes it saw there (`undefined` when it was absent). */
export interface TransitionRead {
  readonly key: string;
  readonly value: Uint8Array | undefined;
}

/**
 * The reads one submission makes, memoized so the validator, the plan, and the
 * receipt agree about what the store held when validation ran.
 *
 * Every read is also recorded as a key and the bytes seen there, and
 * {@link TransitionReader.readSet} hands them to `commit()` as conditions of the
 * batch. A decision validation made on state that has since changed therefore
 * cannot apply: the commit fails as a conflict instead of committing a proposal
 * whose premise is gone.
 *
 * `recallable` and `embeddingProfile` are the reads not recorded. Both feed the
 * embedding fit, which the store guards itself: every commit that writes an
 * embedded record reads and conditions on the namespace's embedding profile
 * marker in its own batch, and scans the namespace under it. Recording the
 * marker here as well would conflict two creators that share a profile for no
 * reason.
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
  /** The namespace's embedding profile marker, when a commit has written one. */
  embeddingProfile(namespace: string): Promise<EmbeddingProfile | undefined>;
  /** Every key read so far with the bytes seen there, once each, in the order first read. */
  readSet(): TransitionRead[];
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
  storage: Pick<EvidenceProjectionStorage, 'listProjections' | 'getEmbeddingProfile'> & {
    readonly [RAW_READS]: EvidenceProjectionRawReads;
  },
  tenantId: string,
): TransitionReader {
  const raw = storage[RAW_READS];
  const evidence = new Map<string, Promise<EvidenceRecord | undefined>>();
  const superseded = new Map<string, Promise<boolean>>();
  const projections = new Map<string, Promise<EvidenceProjectionRecord | undefined>>();
  const revisions = new Map<string, Promise<EvidenceProjectionRecord | undefined>>();
  const recallable = new Map<string, Promise<EvidenceProjectionRecord[]>>();
  const profiles = new Map<string, Promise<EmbeddingProfile | undefined>>();
  const reads = new Map<string, Uint8Array | undefined>();
  const address = (...parts: Array<string | number>): string => JSON.stringify(parts);
  /** Records the key and the exact bytes the store returned, and hands back the decoded record. */
  const observe = <Record>(read: RawRead<Record>): Record | undefined => {
    if (!reads.has(read.key)) reads.set(read.key, read.raw);
    return read.record;
  };
  return {
    evidence: (id) => memoize(evidence, id, async () => observe(await raw.evidence(tenantId, id))),
    isSuperseded: (id) =>
      memoize(
        superseded,
        id,
        async () => observe(await raw.evidenceSupersession(tenantId, id)) !== undefined,
      ),
    projection: (namespace, id) =>
      memoize(projections, address(namespace, id), async () =>
        observe(await raw.projection(tenantId, namespace, id)),
      ),
    projectionRevision: (namespace, id, revision) =>
      memoize(revisions, address(namespace, id, revision), async () =>
        observe(await raw.projectionRevision(tenantId, namespace, id, revision)),
      ),
    embeddingProfile: (namespace) =>
      memoize(profiles, namespace, () => storage.getEmbeddingProfile(tenantId, namespace)),
    recallable: (namespace) =>
      memoize(recallable, namespace, () =>
        storage.listProjections({ tenantId, namespace, status: ['active', 'demoted'] }),
      ),
    readSet: () => [...reads].map(([key, value]) => ({ key, value })),
  };
}
