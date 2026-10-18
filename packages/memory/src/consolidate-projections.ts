import { type ProjectionReference, projectionText } from './evidence-projection-schema';
import {
  EvidenceProjectionCommitError,
  type EvidenceProjectionStorage,
} from './evidence-projection-storage';
import type { MemoryAuthority } from './governance/authority';
import type { TransitionEngine } from './transition-engine';
import type { TransitionResult } from './transition-outcome';

export interface ConsolidateProjectionsOptions {
  readonly engine: TransitionEngine;
  /** The authority the consolidation runs under; its tenant, owner, and policy revision are the proposal's. */
  readonly authority: MemoryAuthority;
  readonly operationId: string;
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
  /** The prompt or algorithm revision that produced the summary, recorded on the receipt. */
  readonly promptRevision: string;
  /** Embeds the summary. Its model and dimension must match the embeddings that stay recallable. */
  readonly embed?: (text: string) => Promise<{ model: string; vector: number[] }>;
  /** Aborting before the submission returns `canceled` with no events and no engine call. */
  readonly signal?: AbortSignal;
  /**
   * Loads each candidate's text at its referenced revision for `summarize`.
   * That revision is immutable history, so reading it can never be stale; whether
   * it is still current is the engine's to detect.
   */
  readonly storage: Pick<EvidenceProjectionStorage, 'getProjectionRevision'>;
}

/**
 * The projection-based successor of in-place consolidation. It never rewrites a
 * record: it asks `summarize` (and `embed`) for the summary, builds one
 * `consolidate` proposal, and submits it through the transition engine, which
 * validates it and commits the summary, the retired or demoted candidates, and
 * the receipt in one batch. The candidates' earlier revisions stay in history,
 * so lineage back to the source evidence is never lost.
 *
 * A reference to a revision that does not exist throws
 * `EvidenceProjectionCommitError` (`projection-not-found`) before `summarize`
 * runs, the way a malformed proposal throws: the caller named nothing. Every
 * other result, including a candidate that is no longer current, is the
 * engine's outcome.
 */
export async function consolidateProjections(
  options: ConsolidateProjectionsOptions,
): Promise<TransitionResult> {
  const { authority, namespace, storage, signal } = options;
  const texts: string[] = [];
  for (const reference of options.candidates) {
    const candidate = await storage.getProjectionRevision(
      authority.tenantId,
      namespace,
      reference.id,
      reference.revision,
    );
    if (candidate === undefined) {
      throw new EvidenceProjectionCommitError(
        'projection-not-found',
        `Candidate ${namespace}/${reference.id}@${reference.revision} does not exist.`,
      );
    }
    texts.push(projectionText(candidate));
  }
  const text = await options.summarize(texts);
  const embedding = options.embed === undefined ? undefined : await options.embed(text);
  if (signal?.aborted === true) return { outcome: 'canceled' };

  return options.engine.submit(
    {
      kind: 'consolidate',
      operationId: options.operationId,
      tenantId: authority.tenantId,
      authority,
      namespace,
      candidates: options.candidates.map(({ id, revision }) => ({ id, revision })),
      outcome: options.outcome,
      summary: { id: options.summaryId, text, ...(embedding === undefined ? {} : { embedding }) },
      projectorRevision: options.projectorRevision,
      promptRevision: options.promptRevision,
    },
    signal === undefined ? undefined : { signal },
  );
}
