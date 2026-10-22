import {
  PROCEDURE_REVIEWER_KINDS,
  type ProcedurePayloadV2,
  type ProjectionReference,
  type ProjectionSource,
} from './evidence-projection-schema';
import { digestOfText } from './evidence-schema';
import type { MemoryAuthority, MemoryPrincipal } from './governance/authority';
import {
  type ProcedureCandidate,
  ProcedureCandidateError,
  assertDistinctEpisodes,
  readCurrentEpisodes,
} from './procedure-candidate';
import type { TransitionEngine } from './transition-engine';
import type { TransitionResult } from './transition-outcome';
import type { TransitionProposal } from './transition-proposal';

/**
 * What one validation run found. `fixture` is the exact fixture it ran and
 * `evidence` what it observed; both are digested into the promoted procedure's
 * provenance, and the observation is kept verbatim.
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
  /**
   * The `requestDigest` of the exact {@link ProcedureReviewRequest} decided. A
   * decision for another procedure, operation, candidate, or fixture does not
   * match, so an approval cannot be carried over to anything it did not see.
   */
  readonly requestDigest: string;
  /** A person: a `user` or `governance` principal. Any other kind is refused. */
  readonly reviewer: MemoryPrincipal;
  readonly approved: boolean;
  readonly decidedAt: number;
}

/** What {@link promoteProcedure} needs: the candidate, its validator, and, for a high-impact one, a review. */
export interface PromoteProcedureOptions {
  readonly engine: TransitionEngine;
  /** The authority the promotion is written under; it needs `memory:write` and the candidate's tenant. */
  readonly authority: MemoryAuthority;
  readonly candidate: ProcedureCandidate;
  /** The procedure projection's id. */
  readonly id: string;
  /** Names the promotion's transition, so a retried promotion replays instead of writing twice. */
  readonly operationId: string;
  readonly projectorRevision: string;
  /** Without one, nothing validates the candidate, and promotion refuses it. */
  readonly validator?: ProcedureValidator;
  /** Required for a high-impact candidate; without it, promotion stops at `pending-review`. */
  readonly review?: ProcedureReviewDecision;
  /**
   * The current revision of procedure `id` that this validation replaces. The
   * replacement is a `rebuilt` revision of the same procedure, so the old one
   * stays in its history; a revision that is no longer current is refused by
   * the engine.
   */
  readonly replaces?: number;
  readonly confidence?: number;
}

/** What a high-impact promotion waits on: everything a reviewer needs to decide it. */
export interface ProcedureReviewRequest {
  readonly procedureId: string;
  readonly operationId: string;
  readonly title: string;
  readonly scope: 'high-impact';
  readonly sideEffects: readonly string[];
  readonly validator: {
    readonly name: string;
    readonly revision: string;
    readonly kind: 'deterministic' | 'evaluator';
  };
  readonly fixtureDigest: string;
  /** Digest of what the validation observed, so a different observation needs a new review. */
  readonly observationDigest: string;
  /** Digest of the frozen candidate the request is for. */
  readonly candidateDigest: string;
  /** Digest of everything above; a decision names it to say which request it decides. */
  readonly requestDigest: string;
}

/**
 * The outcome of a promotion.
 *
 * - `refused`: nothing was written. `unvalidated` when no validator ran (a
 *   success count is not validation), `validation-failed` when it failed,
 *   `review-declined`, `review-not-human`, or `review-mismatch` (a decision
 *   for another request) for the review gate,
 *   `episode-withdrawn` when an episode the candidate rests on is no longer
 *   current, and `wrong-tenant` when the candidate was extracted for another
 *   tenant than the authority's.
 * - `pending-review`: validation passed, but a high-impact procedure needs a
 *   reviewer's decision first. Nothing was written; promote again with the
 *   decision. A host routes this through its own approval path.
 * - `promoted`: the procedure revision is committed in one transition.
 * - `rejected`: the engine refused the transition; `result` says why.
 */
export type ProcedurePromotion =
  | {
      readonly status: 'refused';
      readonly reason:
        | 'unvalidated'
        | 'validation-failed'
        | 'review-declined'
        | 'review-not-human'
        | 'review-mismatch'
        | 'episode-withdrawn'
        | 'contradictory-episodes'
        | 'wrong-tenant';
      readonly detail: string;
      readonly run?: ProcedureValidationRun;
    }
  | { readonly status: 'pending-review'; readonly request: ProcedureReviewRequest }
  | {
      readonly status: 'promoted';
      readonly procedure: ProjectionReference;
      readonly result: TransitionResult;
    }
  | { readonly status: 'rejected'; readonly result: TransitionResult };

/** The options with the review decision and the validator's identity copied and frozen. */
function freezeOptions(options: PromoteProcedureOptions): PromoteProcedureOptions {
  const { validator, review } = options;
  return {
    ...options,
    ...(review === undefined ? {} : { review: deepFreeze(structuredClone(review)) }),
    ...(validator === undefined
      ? {}
      : {
          validator: Object.freeze({
            name: validator.name,
            revision: validator.revision,
            kind: validator.kind,
            validate: (candidate: ProcedureCandidate) => validator.validate(candidate),
          }),
        }),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function procedurePayload(
  candidate: ProcedureCandidate,
  validator: ProcedureValidator,
  run: ProcedureValidationRun,
  review: ProcedureReviewDecision | undefined,
): ProcedurePayloadV2 {
  const { scope, ...draft } = candidate.draft;
  return {
    version: 2,
    ...draft,
    approval: { scope, required: scope === 'high-impact' },
    provenance: {
      successfulEpisodes: [...candidate.successfulEpisodes],
      failedEpisodes: [...candidate.failedEpisodes],
      validation: {
        evaluator: { name: validator.name, revision: validator.revision, kind: validator.kind },
        fixtureDigest: digestOfText(run.fixture),
        outcome: 'passed',
        observation: run.evidence,
        observationDigest: digestOfText(run.evidence),
      },
      ...(review === undefined
        ? {}
        : {
            review: {
              reviewer: { kind: review.reviewer.kind, id: review.reviewer.id },
              decidedAt: review.decidedAt,
              reviewId: review.reviewId,
            },
          }),
    },
  } as ProcedurePayloadV2;
}

/**
 * The one transition that commits a promotion: a new procedure, or a rebuilt
 * revision of the one it replaces. Nothing in it reads the clock, so a retried
 * promotion has the same digest and replays its receipt.
 */
function promotionProposal(
  options: PromoteProcedureOptions,
  candidate: ProcedureCandidate,
  validator: ProcedureValidator,
  run: ProcedureValidationRun,
): TransitionProposal {
  const { authority } = options;
  // Only a review the high-impact gate verified is recorded; a routine promotion records none.
  const verifiedReview = candidate.draft.scope === 'high-impact' ? options.review : undefined;
  const payload = procedurePayload(candidate, validator, run, verifiedReview);
  const base = { operationId: options.operationId, tenantId: authority.tenantId, authority };
  const confidence = options.confidence ?? 0.5;
  if (options.replaces !== undefined) {
    return {
      ...base,
      kind: 'revise-projection',
      revisions: [
        {
          namespace: candidate.namespace,
          id: options.id,
          expectedRevision: options.replaces,
          change: {
            kind: 'rebuilt',
            sources: [...candidate.sources],
            payload,
            confidence,
            projectorRevision: options.projectorRevision,
          },
        },
      ],
    };
  }
  return {
    ...base,
    kind: 'create-projection',
    projections: [
      {
        id: options.id,
        tenantId: authority.tenantId,
        namespace: candidate.namespace,
        kind: 'procedure',
        projectorRevision: options.projectorRevision,
        sources: [...candidate.sources],
        confidence,
        payload,
      },
    ],
  };
}

/**
 * Checks a candidate can be promoted under this authority before anything runs,
 * and returns the evidence its episodes rest on as read now: the sources the
 * procedure is stored with, whatever the candidate value claims.
 */
async function verifiedSources(
  options: PromoteProcedureOptions,
  candidate: ProcedureCandidate,
  settled: boolean,
): Promise<{ readonly refusal: ProcedurePromotion } | { readonly sources: ProjectionSource[] }> {
  if (candidate.tenantId !== options.authority.tenantId) {
    return {
      refusal: {
        status: 'refused',
        reason: 'wrong-tenant',
        detail: `The candidate was extracted for tenant "${candidate.tenantId}", not "${options.authority.tenantId}".`,
      },
    };
  }
  const reviewer = options.review?.reviewer.kind;
  if (
    reviewer !== undefined &&
    !(PROCEDURE_REVIEWER_KINDS as readonly string[]).includes(reviewer)
  ) {
    return {
      refusal: {
        status: 'refused',
        reason: 'review-not-human',
        detail: `A ${reviewer} principal cannot review a procedure; only a person can.`,
      },
    };
  }
  // A promotion that already committed replays its receipt: its episodes are not
  // re-read, since one revoked since then cannot undo a commit that happened, and the
  // engine still refuses a retry that is not the same proposal.
  if (settled) return { sources: [...candidate.sources] };
  try {
    assertDistinctEpisodes(candidate.successfulEpisodes, candidate.failedEpisodes);
    const sources = await readCurrentEpisodes(
      {
        storage: options.engine.storage,
        tenantId: candidate.tenantId,
        namespace: candidate.namespace,
      },
      [...candidate.successfulEpisodes, ...candidate.failedEpisodes],
    );
    return { sources: [...new Map(sources.map((source) => [source.evidenceId, source])).values()] };
  } catch (error) {
    if (!(error instanceof ProcedureCandidateError)) throw error;
    const reason =
      error.code === 'contradictory-episodes' ? 'contradictory-episodes' : 'episode-withdrawn';
    return { refusal: { status: 'refused', reason, detail: error.message } };
  }
}

/** The review gate: a high-impact candidate waits for an approving decision from a person. */
function reviewGate(
  options: PromoteProcedureOptions,
  candidate: ProcedureCandidate,
  validator: ProcedureValidator,
  run: ProcedureValidationRun,
): ProcedurePromotion | undefined {
  if (candidate.draft.scope !== 'high-impact') return undefined;
  const { review } = options;
  const unsigned = {
    procedureId: options.id,
    operationId: options.operationId,
    title: candidate.draft.title,
    scope: 'high-impact' as const,
    sideEffects: candidate.draft.sideEffects,
    validator: { name: validator.name, revision: validator.revision, kind: validator.kind },
    fixtureDigest: digestOfText(run.fixture),
    observationDigest: digestOfText(run.evidence),
    candidateDigest: digestOfText(JSON.stringify(candidate)),
  };
  const request = { ...unsigned, requestDigest: digestOfText(JSON.stringify(unsigned)) };
  if (review === undefined) return { status: 'pending-review', request };
  if (review.requestDigest !== request.requestDigest) {
    return {
      status: 'refused',
      reason: 'review-mismatch',
      detail: `Review ${review.reviewId} decided another request than this promotion's.`,
    };
  }
  return review.approved
    ? undefined
    : {
        status: 'refused',
        reason: 'review-declined',
        detail: `Review ${review.reviewId} declined it.`,
      };
}

/**
 * Promotes a candidate to a validated procedure, in one transition. A validator
 * must run and pass; its fixture digest and its observation become the
 * procedure's provenance, which the receipt's record digest covers. A
 * high-impact candidate also waits for a person: the first call returns
 * `pending-review`, and only a call carrying an approving decision commits.
 *
 * The candidate is snapshotted and frozen first, so neither the caller nor the
 * validator can change what is stored after it was validated; its episodes are
 * read again, so one withdrawn since extraction refuses the promotion. The
 * engine enforces the invariants again (`procedure.causal-step-claimed`,
 * `procedure.high-impact-reviewed`), so a proposal written by hand cannot skip them.
 */
export async function promoteProcedure(
  options: PromoteProcedureOptions,
): Promise<ProcedurePromotion> {
  // Everything external code could change while the validator runs is fixed now:
  // the candidate, the review decision, and the validator's identity.
  const frozen = freezeOptions(options);
  const snapshot = structuredClone(options.candidate);
  const settled =
    (await options.engine.getReceipt(options.authority.tenantId, options.operationId)) !==
    undefined;
  const verified = await verifiedSources(frozen, snapshot, settled);
  if ('refusal' in verified) return verified.refusal;
  // The stored sources are the episodes' evidence as just read, never the candidate's claim.
  const candidate = deepFreeze({ ...snapshot, sources: verified.sources });
  const { validator } = frozen;
  if (validator === undefined) {
    return {
      status: 'refused',
      reason: 'unvalidated',
      detail: `Nothing validated the candidate; ${candidate.successfulEpisodes.length} successful episodes alone do not promote a procedure.`,
    };
  }
  const run = deepFreeze(structuredClone(await validator.validate(candidate)));
  if (run.outcome !== 'passed') {
    return { status: 'refused', reason: 'validation-failed', detail: run.evidence, run };
  }
  const gate = reviewGate(frozen, candidate, validator, run);
  if (gate !== undefined) return gate;
  const result = await options.engine.submit(promotionProposal(frozen, candidate, validator, run));
  if (result.outcome !== 'committed') return { status: 'rejected', result };
  return {
    status: 'promoted',
    procedure: {
      id: options.id,
      revision: options.replaces === undefined ? 1 : options.replaces + 1,
    },
    result,
  };
}
