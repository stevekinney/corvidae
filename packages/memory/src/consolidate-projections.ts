import {
  type EvidenceProjectionRecord,
  type ProjectionReference,
  type ProjectionSource,
  projectionText,
} from './evidence-projection-schema';
import {
  type EvidenceProjectionCommitResult,
  type EvidenceProjectionStorage,
  ProjectionRevisionConflictError,
} from './evidence-projection-storage';

export interface ConsolidateProjectionsOptions {
  readonly storage: EvidenceProjectionStorage;
  readonly tenantId: string;
  readonly namespace: string;
  /** The exact current revisions to fold into one summary. */
  readonly candidates: readonly ProjectionReference[];
  /**
   * `supersede` retires the candidates for good; `demote` keeps them recallable
   * at lower weight and so does not claim to have replaced them.
   */
  readonly outcome: 'supersede' | 'demote';
  readonly summarize: (texts: readonly string[]) => Promise<string>;
  readonly summaryId: string;
  readonly projectorRevision: string;
  readonly policyRevision: string;
  readonly now: () => number;
  readonly embed?: (text: string) => Promise<{ model: string; vector: number[] }>;
}

export interface ConsolidateProjectionsResult {
  readonly summary: EvidenceProjectionRecord;
  readonly commit: EvidenceProjectionCommitResult;
}

async function loadCandidates(
  options: ConsolidateProjectionsOptions,
): Promise<EvidenceProjectionRecord[]> {
  const { storage, tenantId, namespace } = options;
  const loaded: EvidenceProjectionRecord[] = [];
  for (const reference of options.candidates) {
    const current = await storage.getProjection(tenantId, namespace, reference.id);
    const consolidatable = current?.status === 'active' || current?.status === 'demoted';
    if (current === undefined || current.revision !== reference.revision || !consolidatable) {
      throw new ProjectionRevisionConflictError(tenantId, namespace, [reference.id]);
    }
    loaded.push(current);
  }
  return loaded;
}

/**
 * The projection-based successor of in-place consolidation. It never rewrites a
 * record: one commit adds a summary projection that covers the candidates and
 * carries the union of their evidence sources, and writes a new `superseded`
 * (or `demoted`) revision of each candidate pointing at the summary. The
 * candidates' earlier revisions stay in history, so lineage back to the source
 * evidence is never lost.
 */
export async function consolidateProjections(
  options: ConsolidateProjectionsOptions,
): Promise<ConsolidateProjectionsResult> {
  const { storage, tenantId, namespace, outcome, summaryId } = options;
  const candidates = await loadCandidates(options);
  const at = options.now();
  const text = await options.summarize(candidates.map(projectionText));
  const embedding = options.embed === undefined ? undefined : await options.embed(text);

  const sources = new Map<string, ProjectionSource>();
  for (const candidate of candidates) {
    for (const source of candidate.sources) sources.set(source.evidenceId, source);
  }
  const covers = candidates.map(({ id, revision }) => ({ id, revision }));
  const summary: EvidenceProjectionRecord = {
    schemaVersion: 1,
    id: summaryId,
    tenantId,
    namespace,
    kind: 'summary',
    revision: 1,
    projectorRevision: options.projectorRevision,
    policyRevision: options.policyRevision,
    sources: [...sources.values()],
    validity: { validFrom: at },
    confidence: Math.min(...candidates.map((candidate) => candidate.confidence)),
    status: 'active',
    transition:
      outcome === 'supersede'
        ? { kind: 'created', at, supersedes: covers }
        : { kind: 'created', at },
    ...(embedding === undefined ? {} : { embedding }),
    payload: { text, covers },
  };

  const successor: ProjectionReference = { id: summaryId, revision: 1 };
  const retired = candidates.map((candidate): EvidenceProjectionRecord => {
    const base = { ...candidate, revision: candidate.revision + 1 };
    return outcome === 'supersede'
      ? {
          ...base,
          status: 'superseded',
          validity: { ...candidate.validity, validUntil: at },
          transition: { kind: 'superseded', at, supersededBy: successor },
        }
      : {
          ...base,
          status: 'demoted',
          transition: { kind: 'demoted', at, demotedBy: successor },
        };
  });

  const commit = await storage.commit({ tenantId, projections: [summary, ...retired] });
  return { summary, commit };
}
