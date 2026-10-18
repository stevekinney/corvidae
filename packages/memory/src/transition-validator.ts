import {
  encodeEvidenceProjectionRecord,
  type ProjectionSource,
} from './evidence-projection-schema';
import type { EvidenceRecord } from './evidence-schema';
import {
  assertMemoryAuthority,
  MemoryAuthorityError,
  type MemoryOperation,
} from './governance/authority';
import { decideMemoryAccess, type MemoryResourceDescriptor } from './governance/predicate';
import { checkTypeInvariants } from './transition-invariants';
import type { TransitionRejectionReason } from './transition-outcome';
import {
  buildTransitionPlan,
  plannedProjections,
  projectionLabel,
  type RevisionPlan,
  type TransitionPlan,
  TransitionPlanError,
  type TransitionValidationContext,
} from './transition-plan';
import type { ProposedEvidence, TransitionProposal } from './transition-proposal';
import type { TransitionValidationCheck } from './transition-receipt';

export type TransitionRefusal = {
  readonly reason: TransitionRejectionReason;
  readonly detail: string;
};

export type ValidationResult =
  | {
      readonly ok: true;
      readonly plan: TransitionPlan;
      readonly checks: TransitionValidationCheck[];
    }
  | ({ readonly ok: false } & TransitionRefusal);

const refuse = (reason: TransitionRejectionReason, detail: string): TransitionRefusal => ({
  reason,
  detail,
});

function proposedEvidenceOf(proposal: TransitionProposal): readonly ProposedEvidence[] {
  switch (proposal.kind) {
    case 'append-evidence':
      return proposal.evidence;
    case 'correct-evidence':
      return [proposal.successor];
    default:
      return [];
  }
}

function descriptorOf(
  record: Pick<EvidenceRecord, 'tenantId' | 'ownerId' | 'authorizationScope'>,
): MemoryResourceDescriptor {
  return {
    tenantId: record.tenantId,
    ownerId: record.ownerId,
    visibility: record.authorizationScope.visibility,
    state: 'active',
    sharedWith: record.authorizationScope.sharedWith,
    integrity: 'intact',
    pendingDerivation: false,
  };
}

/** The sources one proposed projection or revision rests on, and the operation it needs on them. */
interface SourceClaim {
  readonly label: string;
  readonly operation: MemoryOperation;
  readonly sources: readonly ProjectionSource[];
  /** Whether the proposal supplied these sources, as opposed to inheriting a stored revision's. */
  readonly supplied: boolean;
}

async function sourceClaims({
  proposal,
  reader,
}: TransitionValidationContext): Promise<SourceClaim[]> {
  const claims: SourceClaim[] = [];
  if (proposal.kind === 'create-projection' || proposal.kind === 'correct-evidence') {
    for (const projection of proposal.projections ?? []) {
      claims.push({
        label: projectionLabel(projection),
        operation: 'write',
        sources: projection.sources,
        supplied: true,
      });
    }
  }
  if (proposal.kind === 'revise-projection' || proposal.kind === 'correct-evidence') {
    for (const revision of proposal.revisions ?? []) {
      const { change } = revision;
      const current =
        change.kind === 'rebuilt'
          ? undefined
          : await reader.projection(revision.namespace, revision.id);
      claims.push({
        label: projectionLabel(revision),
        operation: change.kind === 'revoked' ? 'revoke' : 'write',
        sources: change.kind === 'rebuilt' ? change.sources : (current?.sources ?? []),
        supplied: change.kind === 'rebuilt',
      });
    }
  }
  if (proposal.kind === 'consolidate') {
    for (const candidate of proposal.candidates) {
      const current = await reader.projection(proposal.namespace, candidate.id);
      claims.push({
        label: projectionLabel({ namespace: proposal.namespace, ...candidate }),
        operation: 'write',
        sources: current?.sources ?? [],
        supplied: false,
      });
    }
  }
  return claims;
}

/** Evidence the proposal names, found among its own or in the store. */
async function resolveEvidence(
  context: TransitionValidationContext,
  id: string,
): Promise<ProposedEvidence | EvidenceRecord | undefined> {
  return (
    proposedEvidenceOf(context.proposal).find((record) => record.id === id) ??
    (await context.reader.evidence(id))
  );
}

/**
 * Check 1. The authority is validated whole first: the schema only shape-checks
 * it, and `decideMemoryAccess` trusts `capabilities` without re-reading the
 * delegation chain, so a capability the chain never granted would otherwise pass.
 * A source that cannot be found passes here and fails coverage.
 */
async function checkAuthorization(
  context: TransitionValidationContext,
): Promise<TransitionRefusal | undefined> {
  const { proposal, reader } = context;
  try {
    assertMemoryAuthority(proposal.authority);
  } catch (error) {
    if (error instanceof MemoryAuthorityError) return refuse('unauthorized', error.message);
    throw error;
  }
  const deny = (
    operation: MemoryOperation,
    record: ProposedEvidence | EvidenceRecord,
    what: string,
  ) => {
    const decision = decideMemoryAccess(proposal.authority, operation, descriptorOf(record));
    return decision.allowed
      ? undefined
      : refuse('unauthorized', `${operation} on ${what} is denied: ${decision.reason}.`);
  };
  for (const record of proposedEvidenceOf(proposal)) {
    const refusal = deny('write', record, `evidence "${record.id}"`);
    if (refusal !== undefined) return refusal;
  }
  if (proposal.kind === 'correct-evidence') {
    for (const id of proposal.successor.supersedes ?? []) {
      const predecessor = await reader.evidence(id);
      if (predecessor === undefined) continue;
      const refusal = deny('write', predecessor, `the evidence "${id}" it supersedes`);
      if (refusal !== undefined) return refusal;
    }
  }
  for (const claim of await sourceClaims(context)) {
    for (const source of claim.sources) {
      const evidence = await resolveEvidence(context, source.evidenceId);
      if (evidence === undefined) continue;
      const refusal = deny(
        claim.operation,
        evidence,
        `evidence "${source.evidenceId}" under ${claim.label}`,
      );
      if (refusal !== undefined) return refusal;
    }
  }
  return undefined;
}

/** Check 2: every source a proposal supplies names stored evidence or evidence in the same proposal. */
async function checkCoverage(
  context: TransitionValidationContext,
): Promise<TransitionRefusal | undefined> {
  for (const claim of await sourceClaims(context)) {
    if (!claim.supplied) continue;
    for (const source of claim.sources) {
      if ((await resolveEvidence(context, source.evidenceId)) === undefined) {
        return refuse(
          'evidence-not-covered',
          `${claim.label} names evidence "${source.evidenceId}", which is neither stored nor in the proposal.`,
        );
      }
    }
  }
  return undefined;
}

/** Check 3: each source digest equals its evidence's digest. */
async function checkFaithfulness(
  context: TransitionValidationContext,
): Promise<TransitionRefusal | undefined> {
  for (const claim of await sourceClaims(context)) {
    if (!claim.supplied) continue;
    for (const source of claim.sources) {
      const evidence = await resolveEvidence(context, source.evidenceId);
      if (evidence !== undefined && evidence.digest !== source.digest) {
        return refuse(
          'source-digest-mismatch',
          `${claim.label} records a digest for evidence "${source.evidenceId}" that differs from the evidence.`,
        );
      }
    }
  }
  return undefined;
}

function revisionOf(plan: TransitionPlan, namespace: string, id: string): RevisionPlan | undefined {
  return plan.revisions.find((revision) => revision.namespace === namespace && revision.id === id);
}

/**
 * Whether the projection a reference names is active once the proposal has been
 * applied: created or rebuilt in it, or stored active and not retired by it.
 */
async function activeAfter(
  { reader }: TransitionValidationContext,
  plan: TransitionPlan,
  namespace: string,
  reference: { id: string; revision: number },
): Promise<boolean> {
  const inProposal = plan.created.find(
    (record) =>
      record.namespace === namespace &&
      record.id === reference.id &&
      record.revision === reference.revision,
  );
  if (inProposal !== undefined) return true;
  const revision = revisionOf(plan, namespace, reference.id);
  if (revision !== undefined) {
    return revision.next?.status === 'active' && revision.next.revision === reference.revision;
  }
  const stored = await reader.projection(namespace, reference.id);
  return stored?.status === 'active' && stored.revision === reference.revision;
}

/**
 * Check 4. The proposal cannot carry the fields a non-rebuilt revision may not
 * change, since the engine copies them from the current revision, so this
 * checks the state the proposal leaves behind: a retired projection names a
 * successor that is active afterwards, a created projection supersedes only
 * what the same proposal supersedes, and a correction supersedes only evidence
 * that is stored and not already superseded.
 */
async function checkPriorState(
  context: TransitionValidationContext,
  plan: TransitionPlan,
): Promise<TransitionRefusal | undefined> {
  for (const revision of plan.revisions) {
    if (revision.next === undefined) continue;
    const { transition } = revision.next;
    const successor =
      transition.kind === 'superseded'
        ? transition.supersededBy
        : transition.kind === 'demoted'
          ? transition.demotedBy
          : undefined;
    if (
      successor !== undefined &&
      !(await activeAfter(context, plan, revision.namespace, successor))
    ) {
      return refuse(
        'prior-state-not-preserved',
        `${projectionLabel(revision)} would be ${transition.kind} by ${projectionLabel({ namespace: revision.namespace, ...successor })}, which is not active after the proposal.`,
      );
    }
  }
  for (const record of plan.created) {
    if (record.transition.kind !== 'created') continue;
    for (const reference of record.transition.supersedes ?? []) {
      const retired = revisionOf(plan, record.namespace, reference.id);
      const retires =
        retired?.changeKind === 'superseded' && retired.expectedRevision === reference.revision;
      if (!retires) {
        return refuse(
          'prior-state-not-preserved',
          `${projectionLabel(record)} supersedes ${projectionLabel({ namespace: record.namespace, ...reference })}, which the proposal does not supersede.`,
        );
      }
    }
  }
  for (const id of plan.supersededEvidence) {
    const stored = await context.reader.evidence(id);
    if (stored === undefined) {
      return refuse('prior-state-not-preserved', `Evidence "${id}" to supersede is not stored.`);
    }
    if (await context.reader.isSuperseded(id)) {
      return refuse('prior-state-not-preserved', `Evidence "${id}" is already superseded.`);
    }
  }
  return undefined;
}

/**
 * Check 5. A revision is not stamped before the revision it follows; a
 * successor projection is not valid from before its predecessor; a record's
 * validity window is non-empty once the clock has filled its bounds. Ordering
 * the schema can see within one record is the schema's job.
 */
async function checkTemporal(
  context: TransitionValidationContext,
  plan: TransitionPlan,
): Promise<TransitionRefusal | undefined> {
  for (const revision of plan.revisions) {
    const { current, next } = revision;
    if (current === undefined || next === undefined) continue;
    if (next.transition.at < current.transition.at) {
      return refuse(
        'temporal-inconsistency',
        `${projectionLabel(revision)} would be stamped ${next.transition.at}, before the revision it follows (${current.transition.at}).`,
      );
    }
    const { validFrom, validUntil } = next.validity;
    if (validUntil !== undefined && validUntil <= validFrom) {
      return refuse(
        'temporal-inconsistency',
        `${projectionLabel(revision)} would be valid until ${validUntil}, not after it begins (${validFrom}).`,
      );
    }
  }
  for (const record of plan.created) {
    if (record.transition.kind !== 'created') continue;
    for (const reference of record.transition.supersedes ?? []) {
      const predecessor = await context.reader.projectionRevision(
        record.namespace,
        reference.id,
        reference.revision,
      );
      if (predecessor !== undefined && record.validity.validFrom < predecessor.validity.validFrom) {
        return refuse(
          'temporal-inconsistency',
          `${projectionLabel(record)} is valid from ${record.validity.validFrom}, before the ${projectionLabel({ namespace: record.namespace, ...reference })} it supersedes (${predecessor.validity.validFrom}).`,
        );
      }
    }
  }
  return undefined;
}

/**
 * Check 6, the `duration` rule only: evidence is expired when
 * `writtenAt + milliseconds <= the transition time`. It applies to evidence in
 * the proposal and to the source evidence of created and rebuilt projections.
 * Enforcing the other rules belongs to the governance work.
 */
async function checkRetention(
  context: TransitionValidationContext,
  plan: TransitionPlan,
): Promise<TransitionRefusal | undefined> {
  const { at } = context;
  const expired = (record: EvidenceRecord): boolean =>
    record.retention.kind === 'duration' && record.writtenAt + record.retention.milliseconds <= at;
  for (const record of plan.evidence) {
    if (expired(record)) {
      return refuse('retention-expired', `Evidence "${record.id}" is already past its retention.`);
    }
  }
  const rebuilt = plan.revisions.flatMap((revision) =>
    revision.changeKind === 'rebuilt' && revision.next !== undefined ? [revision.next] : [],
  );
  for (const projection of [...plan.created, ...rebuilt]) {
    for (const source of projection.sources) {
      const evidence =
        plan.evidence.find((record) => record.id === source.evidenceId) ??
        (await context.reader.evidence(source.evidenceId));
      if (evidence !== undefined && expired(evidence)) {
        return refuse(
          'retention-expired',
          `${projectionLabel(projection)} rests on evidence "${source.evidenceId}", which is past its retention.`,
        );
      }
    }
  }
  return undefined;
}

/**
 * Encodes every record the plan writes. The checks above cover what they name,
 * and the record schema is the last word: a record that fails it is refused here
 * as malformed rather than surfacing as a throw from the commit.
 */
function checkEncodable(plan: TransitionPlan): TransitionRefusal | undefined {
  for (const record of plannedProjections(plan)) {
    try {
      encodeEvidenceProjectionRecord(record);
    } catch (error) {
      return refuse(
        'malformed',
        `${projectionLabel(record)} would not be a valid projection: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return undefined;
}

const CHECKS: ReadonlyArray<
  readonly [
    TransitionValidationCheck,
    (context: TransitionValidationContext) => Promise<TransitionRefusal | undefined>,
  ]
> = [
  ['authorization', checkAuthorization],
  ['coverage', checkCoverage],
  ['faithfulness', checkFaithfulness],
];

/**
 * Runs the checks in their ruled order and stops at the first failure, whose
 * reason decides the outcome. Authorization, coverage, and faithfulness read the
 * proposal and the store; the plan is built after them, so a rebuilt payload that
 * fits no kind is refused after they pass; the remaining four read the plan.
 * The stale-revision comparison is the engine's, and runs only once every check
 * here has passed, so a proposal both invalid and stale is refused, not
 * conflicted.
 */
export async function validateTransition(
  context: TransitionValidationContext,
): Promise<ValidationResult> {
  const { proposal } = context;
  const checks: TransitionValidationCheck[] = [];
  if (proposal.kind === 'consolidate') {
    if (proposal.candidates.length < 2) {
      return {
        ok: false,
        ...refuse(
          'consolidation-requires-two-candidates',
          `A consolidation needs at least two candidates; this one names ${proposal.candidates.length}.`,
        ),
      };
    }
    checks.push('candidate-count');
  }
  for (const [name, check] of CHECKS) {
    const refusal = await check(context);
    if (refusal !== undefined) return { ok: false, ...refusal };
    checks.push(name);
  }
  let plan: TransitionPlan;
  try {
    plan = await buildTransitionPlan(proposal, context.reader, context.at);
  } catch (error) {
    if (error instanceof TransitionPlanError)
      return { ok: false, ...refuse(error.reason, error.detail) };
    throw error;
  }
  // A consolidation with a stale candidate has no summary to check; the engine reports the conflict.
  if (proposal.kind === 'consolidate' && plan.consolidation === undefined) {
    return { ok: true, plan, checks };
  }
  const planChecks: ReadonlyArray<
    readonly [
      TransitionValidationCheck,
      (
        plan: TransitionPlan,
      ) => Promise<TransitionRefusal | undefined> | TransitionRefusal | undefined,
    ]
  > = [
    ['prior-state', (built) => checkPriorState(context, built)],
    ['temporal', (built) => checkTemporal(context, built)],
    ['retention', (built) => checkRetention(context, built)],
    ['type-invariants', (built) => checkTypeInvariants(context, built)],
  ];
  for (const [name, check] of planChecks) {
    const refusal = await check(plan);
    if (refusal !== undefined) return { ok: false, ...refusal };
    checks.push(name);
  }
  const unencodable = checkEncodable(plan);
  if (unencodable !== undefined) return { ok: false, ...unencodable };
  return { ok: true, plan, checks };
}
