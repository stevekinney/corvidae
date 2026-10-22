import type { ProcedurePayloadV2, ProjectionReference } from './evidence-projection-schema';
import { digestOfText } from './evidence-schema';
import type { EvidenceProducer } from './evidence-schema-primitives';
import type { MemoryAuthority, MemoryPrincipal } from './governance/authority';
import type { ProcedureCandidate } from './procedure-candidate';
import type { TransitionEngine } from './transition-engine';
import type { TransitionResult } from './transition-outcome';
import type { TransitionProposal } from './transition-proposal';

/**
 * What one validation run found. `fixture` is the exact fixture it ran, digested
 * into the promoted procedure's provenance; `evidence` is what it observed, kept
 * verbatim in the outcome evidence record.
 */
export interface ProcedureValidationRun {
  readonly outcome: 'passed' | 'failed';
  readonly fixture: string;
  readonly evidence: string;
  /** For a failed run, the signature of the failure, so it can be recorded as a known failure. */
  readonly failureSignature?: string;
}

/**
 * Validates a candidate. A `deterministic` validator replays the procedure
 * against a fixture and checks its postconditions; an `evaluator` judges it by
 * a named, versioned rubric where no deterministic check exists. Its name and
 * revision are recorded on every procedure it promotes.
 */
export interface ProcedureValidator {
  readonly name: string;
  readonly revision: string;
  readonly kind: 'deterministic' | 'evaluator';
  validate(candidate: ProcedureCandidate): Promise<ProcedureValidationRun>;
}

/** A human reviewer's decision on a high-impact promotion. */
export interface ProcedureReviewDecision {
  readonly reviewId: string;
  readonly reviewer: MemoryPrincipal;
  readonly approved: boolean;
  readonly decidedAt: number;
}

/** What {@link promoteProcedure} needs: the candidate, its validator, and, for a high-impact one, a review. */
export interface PromoteProcedureOptions {
  readonly engine: TransitionEngine;
  /** The authority the promotion is written under; it needs `memory:write`. */
  readonly authority: MemoryAuthority;
  readonly candidate: ProcedureCandidate;
  /** The procedure projection's id. */
  readonly id: string;
  /** Names the promotion's transitions, so a retried promotion replays instead of writing twice. */
  readonly operationId: string;
  readonly projectorRevision: string;
  /** Without one, nothing validates the candidate, and promotion refuses it. */
  readonly validator?: ProcedureValidator;
  /** Required for a high-impact candidate; without it, promotion stops at `pending-review`. */
  readonly review?: ProcedureReviewDecision;
  /** The current revision of a validated procedure this one replaces, superseded in the same batch. */
  readonly supersedes?: ProjectionReference;
  readonly confidence?: number;
  readonly now: () => number;
}

/** What a high-impact promotion waits on: everything a reviewer needs to decide it. */
export interface ProcedureReviewRequest {
  readonly procedureId: string;
  readonly operationId: string;
  readonly title: string;
  readonly scope: 'high-impact';
  readonly sideEffects: readonly string[];
  readonly validator: { readonly name: string; readonly revision: string };
  readonly fixtureDigest: string;
}

/**
 * The outcome of a promotion.
 *
 * - `refused`: nothing was written. `unvalidated` when no validator ran (a
 *   success count is not validation), `validation-failed` when it failed,
 *   `review-declined` when the reviewer said no.
 * - `pending-review`: validation passed, but a high-impact procedure needs a
 *   reviewer's decision first. Nothing was written; promote again with the
 *   decision. A host routes this through its own approval path.
 * - `promoted`: the procedure is committed. `results` are the engine's
 *   receipts, outcome evidence first.
 * - `rejected`: the engine refused a transition; `result` says why.
 */
export type ProcedurePromotion =
  | {
      readonly status: 'refused';
      readonly reason: 'unvalidated' | 'validation-failed' | 'review-declined';
      readonly detail: string;
      readonly run?: ProcedureValidationRun;
    }
  | { readonly status: 'pending-review'; readonly request: ProcedureReviewRequest }
  | {
      readonly status: 'promoted';
      readonly procedure: ProjectionReference;
      readonly results: readonly TransitionResult[];
    }
  | { readonly status: 'rejected'; readonly result: TransitionResult };

function outcomeEvidence(
  options: PromoteProcedureOptions,
  validator: ProcedureValidator,
  run: ProcedureValidationRun,
  fixtureDigest: string,
) {
  const { authority, candidate } = options;
  const text = JSON.stringify({
    procedure: `${candidate.namespace}/${options.id}`,
    validator: { name: validator.name, revision: validator.revision, kind: validator.kind },
    fixtureDigest,
    outcome: run.outcome,
    evidence: run.evidence,
  });
  const at = options.now();
  const producer: EvidenceProducer = {
    kind: 'service',
    id: validator.name,
    version: validator.revision,
  };
  return {
    schemaVersion: 1 as const,
    id: `${options.operationId}:validation`,
    tenantId: authority.tenantId,
    ownerId: authority.ownerId,
    kind: 'tool-result' as const,
    sourceLocator: `procedure-validation:${validator.name}@${validator.revision}`,
    content: { kind: 'inline' as const, text },
    digest: digestOfText(text),
    producer,
    principal: authority.principal,
    // A deterministic replay is checked evidence; an evaluator's judgment is not.
    trustTier: validator.kind === 'deterministic' ? ('verified' as const) : ('untrusted' as const),
    eventAt: at,
    observedAt: at,
    classification: 'internal' as const,
    authorizationScope: { visibility: 'private' as const, sharedWith: [] },
    retention: { kind: 'source-linked' as const },
  };
}

function procedurePayload(
  options: PromoteProcedureOptions,
  validator: ProcedureValidator,
  fixtureDigest: string,
  outcomeEvidenceId: string,
): ProcedurePayloadV2 {
  const { scope, ...draft } = options.candidate.draft;
  const { review } = options;
  return {
    version: 2,
    ...draft,
    approval: { scope, required: scope === 'high-impact' },
    provenance: {
      successfulEpisodes: [...options.candidate.successfulEpisodes],
      failedEpisodes: [...options.candidate.failedEpisodes],
      validation: {
        evaluator: { name: validator.name, revision: validator.revision, kind: validator.kind },
        fixtureDigest,
        outcome: 'passed',
        outcomeEvidenceId,
      },
      ...(review === undefined
        ? {}
        : {
            review: {
              reviewer: review.reviewer,
              decidedAt: review.decidedAt,
              reviewId: review.reviewId,
            },
          }),
    },
  };
}

/** Reads the outcome evidence id a validated procedure revision rests on, for a superseding promotion. */
async function supersededOutcomeEvidence(
  options: PromoteProcedureOptions,
): Promise<string | undefined> {
  if (options.supersedes === undefined) return undefined;
  const previous = await options.engine.storage.getProjectionRevision(
    options.authority.tenantId,
    options.candidate.namespace,
    options.supersedes.id,
    options.supersedes.revision,
  );
  if (previous?.kind !== 'procedure' || !('version' in previous.payload)) return undefined;
  return previous.payload.provenance.validation.outcomeEvidenceId;
}

function committed(result: TransitionResult): boolean {
  return result.outcome === 'committed';
}

/** The proposals that commit a promotion: one batch when it supersedes, otherwise evidence then procedure. */
async function promotionProposals(
  options: PromoteProcedureOptions,
  validator: ProcedureValidator,
  run: ProcedureValidationRun,
  fixtureDigest: string,
): Promise<TransitionProposal[]> {
  const { authority, candidate } = options;
  const evidence = outcomeEvidence(options, validator, run, fixtureDigest);
  const projection = {
    id: options.id,
    tenantId: authority.tenantId,
    namespace: candidate.namespace,
    kind: 'procedure' as const,
    projectorRevision: options.projectorRevision,
    sources: [...candidate.sources, { evidenceId: evidence.id, digest: evidence.digest }],
    confidence: options.confidence ?? 0.5,
    payload: procedurePayload(options, validator, fixtureDigest, evidence.id),
  };
  const base = { operationId: options.operationId, tenantId: authority.tenantId, authority };
  const previousEvidence = await supersededOutcomeEvidence(options);
  if (options.supersedes !== undefined && previousEvidence !== undefined) {
    return [
      {
        ...base,
        kind: 'correct-evidence',
        successor: { ...evidence, supersedes: [previousEvidence] },
        projections: [{ ...projection, supersedes: [options.supersedes] }],
        revisions: [
          {
            namespace: candidate.namespace,
            id: options.supersedes.id,
            expectedRevision: options.supersedes.revision,
            change: { kind: 'superseded', supersededBy: { id: options.id, revision: 1 } },
          },
        ],
      },
    ];
  }
  return [
    {
      ...base,
      operationId: `${options.operationId}:validation`,
      kind: 'append-evidence',
      evidence: [evidence],
    },
    { ...base, kind: 'create-projection', projections: [projection] },
  ];
}

/**
 * Promotes a candidate to a validated procedure. A validator must run and pass,
 * and its exact fixture digest and outcome evidence become the procedure's
 * provenance and one of its sources, so the transition receipt records what the
 * promotion rested on. A high-impact candidate also waits for a reviewer: the
 * first call returns `pending-review`, and only a call carrying an approving
 * decision commits. The engine enforces both again (`procedure.causal-step-claimed`,
 * `procedure.high-impact-reviewed`), so a proposal written by hand cannot skip them.
 */
export async function promoteProcedure(
  options: PromoteProcedureOptions,
): Promise<ProcedurePromotion> {
  const { validator, candidate, review } = options;
  if (validator === undefined) {
    return {
      status: 'refused',
      reason: 'unvalidated',
      detail: `Nothing validated the candidate; ${candidate.successfulEpisodes.length} successful episodes alone do not promote a procedure.`,
    };
  }
  const run = await validator.validate(candidate);
  if (run.outcome !== 'passed') {
    return { status: 'refused', reason: 'validation-failed', detail: run.evidence, run };
  }
  const fixtureDigest = digestOfText(run.fixture);
  if (candidate.draft.scope === 'high-impact') {
    if (review === undefined) {
      return {
        status: 'pending-review',
        request: {
          procedureId: options.id,
          operationId: options.operationId,
          title: candidate.draft.title,
          scope: 'high-impact',
          sideEffects: candidate.draft.sideEffects,
          validator: { name: validator.name, revision: validator.revision },
          fixtureDigest,
        },
      };
    }
    if (!review.approved) {
      return {
        status: 'refused',
        reason: 'review-declined',
        detail: `Review ${review.reviewId} declined it.`,
      };
    }
  }
  const results: TransitionResult[] = [];
  for (const proposal of await promotionProposals(options, validator, run, fixtureDigest)) {
    const result = await options.engine.submit(proposal);
    if (!committed(result)) return { status: 'rejected', result };
    results.push(result);
  }
  return { status: 'promoted', procedure: { id: options.id, revision: 1 }, results };
}
