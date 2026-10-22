import type { MemoryAuthority } from './authority';
import type { MemoryEvidenceKind } from './evidence';
import { resourceOf, type GovernanceContext, type ResolvedRecord } from './governance-context';
import type {
  MemoryRecallExclusion,
  MemoryRecallExclusionReason,
  MemoryRecallFilterReport,
  RecallForModelOptions,
} from './governed-memory-types';
import { resolveTenantPolicy, trustAtLeast, type MemoryGovernancePolicy } from './policy';
import { decideMemoryAccess, type MemoryDenialReason, type MemoryRedaction } from './predicate';
import {
  readRecordGovernance,
  type MemoryRecordSourceReference as RecordReference,
} from './record-governance';
import { retentionExpiry } from './retention';
import {
  MEMORY_POLICY_FILTERS,
  type MemoryPolicyFilter,
  type MemoryRetrievalPlan,
  type MemoryRetrievalStage,
} from './retrieval-plan';

/** A record the caller may read, with what recall has decided about it so far. */
export interface RecallCandidate extends ResolvedRecord {
  readonly redaction: MemoryRedaction;
  readonly revision: string;
  readonly kind: MemoryEvidenceKind;
}

/** The candidates left after the pre-scoring filters and the constraint stages, and what they removed. */
export interface FilteredCandidates {
  /** Every candidate the predicate let this caller read, in listing order. */
  readonly authorized: readonly RecallCandidate[];
  /** The candidates left to score. */
  readonly eligible: readonly RecallCandidate[];
  /** Superseded candidates that passed every policy filter, for the counterevidence stage. */
  readonly superseded: readonly RecallCandidate[];
  readonly exclusions: readonly MemoryRecallExclusion[];
  readonly filters: readonly MemoryRecallFilterReport[];
  readonly constraintStages: ReadonlySet<MemoryRetrievalStage>;
}

/** The filter a predicate denial counts against. */
function denialFilter(reason: MemoryDenialReason): MemoryPolicyFilter {
  if (reason === 'tenant-mismatch') return 'tenant';
  if (reason === 'not-owner') return 'principal';
  if (reason === 'not-active') return 'quarantine';
  return 'resource';
}

function kindOf(resolved: ResolvedRecord): MemoryEvidenceKind {
  const { governance } = resolved.read;
  if (governance.invalidatedAt !== undefined) return 'historical-projection';
  if (governance.lineage?.kind === 'summary') return 'derived-summary';
  if (governance.lineage !== undefined) return 'current-projection';
  if (governance.source === 'model-tool' && governance.trust === 'untrusted') {
    return 'uncertain-claim';
  }
  return 'source-evidence';
}

/** A record's storage version and content digest, which together identify what a recall saw. */
export function revisionOf(resolved: ResolvedRecord): string {
  return `${resolved.record.version}:${resolved.read.governance.contentDigest}`;
}

function candidateOf(resolved: ResolvedRecord, redaction: MemoryRedaction): RecallCandidate {
  return { ...resolved, redaction, revision: revisionOf(resolved), kind: kindOf(resolved) };
}

/**
 * Lists every record in the caller's scopes and keeps those the shared
 * predicate lets it search, counting each denial against the filter it
 * enforces. A denied record contributes only a count: its identifier never
 * reaches the bundle.
 */
async function authorizedCandidates(
  context: GovernanceContext,
  authority: MemoryAuthority,
  scopes: readonly ResolvedRecord['scope'][],
  denials: Map<MemoryPolicyFilter, number>,
): Promise<RecallCandidate[]> {
  const authorized: RecallCandidate[] = [];
  for (const scope of scopes) {
    for (const record of await context.storage.list(scope)) {
      const read = readRecordGovernance(record);
      if (read === undefined) continue;
      const resolved = { record, read, scope };
      const decision = decideMemoryAccess(authority, 'search', resourceOf(resolved));
      if (!decision.allowed) {
        const filter = denialFilter(decision.reason);
        denials.set(filter, (denials.get(filter) ?? 0) + 1);
        continue;
      }
      authorized.push(candidateOf(resolved, decision.redaction));
    }
  }
  return authorized;
}

/** What the filters read. `policy` is the one snapshot the whole recall runs under. */
export interface FilterInput {
  readonly context: GovernanceContext;
  readonly policy: MemoryGovernancePolicy;
  readonly authority: MemoryAuthority;
  readonly options: RecallForModelOptions;
  readonly plan: MemoryRetrievalPlan;
  readonly evicted: ReadonlySet<string>;
}

type Verdict = readonly [MemoryPolicyFilter, MemoryRecallExclusionReason] | undefined;

/**
 * The first policy filter that excludes `candidate`, read entirely from its
 * persisted governance and attribution, never from its content.
 */
function policyVerdict(input: FilterInput, candidate: RecallCandidate, now: number): Verdict {
  const { governance } = candidate.read;
  const { constraints } = input.plan;
  const { policy } = input;
  if (
    constraints.purposes.length > 0 &&
    !constraints.purposes.includes(governance.attribution.purpose)
  ) {
    return ['purpose', 'purpose-mismatch'];
  }
  if (
    input.options.memoryClass !== undefined &&
    governance.memoryClass !== input.options.memoryClass
  ) {
    return ['classification', 'class-mismatch'];
  }
  if (!trustAtLeast(governance.trust, policy.recall.minimumTrust[governance.memoryClass])) {
    return ['trust', 'trust-below-minimum'];
  }
  const expiry = retentionExpiry(
    governance,
    resolveTenantPolicy(policy, input.authority.tenantId).retention,
  );
  // A legal hold suspends retention, so a held record stays recallable after its period ends.
  if (expiry !== undefined && expiry <= now && governance.legalHold !== 'held') {
    return ['retention', 'retention-expired'];
  }
  if (input.evicted.has(candidate.record.id)) return ['eviction', 'evicted'];
  if (governance.state !== 'active') return ['quarantine', 'not-active'];
  if (governance.indexInvalidated) return ['index', 'index-invalidated'];
  return undefined;
}

/** Whether a superseded candidate still counts as evidence: it was current at `asOf`, or history was asked for. */
function historicalAdmitted(plan: MemoryRetrievalPlan, candidate: RecallCandidate): boolean {
  const invalidatedAt = candidate.read.governance.invalidatedAt;
  if (invalidatedAt === undefined) return true;
  const { asOf, includeHistorical } = plan.constraints;
  // `asOf` belongs to the temporal filter: a plan without that stage ignores it.
  if (asOf !== undefined && plan.stages.includes('temporal-filter')) return invalidatedAt > asOf;
  return includeHistorical;
}

/** The constraint stage that excludes `candidate`, if one does. */
function constraintVerdict(
  plan: MemoryRetrievalPlan,
  candidate: RecallCandidate,
): readonly [MemoryRetrievalStage, MemoryRecallExclusionReason] | undefined {
  const { governance } = candidate.read;
  const { constraints, stages } = plan;
  if (
    stages.includes('temporal-filter') &&
    constraints.asOf !== undefined &&
    governance.eventAt > constraints.asOf
  ) {
    return ['temporal-filter', 'outside-time'];
  }
  if (stages.includes('entity-filter') && constraints.entities.length > 0) {
    const content = candidate.record.content.toLowerCase();
    if (!constraints.entities.every((entity) => content.includes(entity))) {
      return ['entity-filter', 'entity-mismatch'];
    }
  }
  if (stages.includes('source-session-constraint')) {
    if (constraints.sources.length > 0 && !constraints.sources.includes(governance.source)) {
      return ['source-session-constraint', 'source-mismatch'];
    }
    if (constraints.runId !== undefined && governance.runId !== constraints.runId) {
      return ['source-session-constraint', 'run-mismatch'];
    }
  }
  return undefined;
}

/** Records why `candidate` was left out, and by which filter or stage. */
export function recallExclusion(
  candidate: RecallCandidate,
  stage: MemoryRecallExclusion['stage'],
  reason: MemoryRecallExclusionReason,
): MemoryRecallExclusion {
  return { recordId: candidate.record.id, revision: candidate.revision, reason, stage };
}

/** Which constraint stages had anything to apply under this plan. */
function appliedConstraintStages(plan: MemoryRetrievalPlan): Set<MemoryRetrievalStage> {
  const { constraints, stages } = plan;
  const applied = new Set<MemoryRetrievalStage>();
  if (stages.includes('temporal-filter') && constraints.asOf !== undefined) {
    applied.add('temporal-filter');
  }
  if (stages.includes('entity-filter') && constraints.entities.length > 0) {
    applied.add('entity-filter');
  }
  if (
    stages.includes('source-session-constraint') &&
    (constraints.sources.length > 0 || constraints.runId !== undefined)
  ) {
    applied.add('source-session-constraint');
  }
  return applied;
}

/**
 * The pre-scoring pipeline. Scope and predicate decide what the caller may
 * read; the policy filters then run in {@link MEMORY_POLICY_FILTERS} order on
 * persisted governance alone; then the constraint stages. Only a candidate
 * that passes all of them is ever scored, and only the entity filter reads
 * content, after every policy filter has passed it.
 */
export async function filterRecallCandidates(
  input: FilterInput,
  scopes: readonly ResolvedRecord['scope'][],
): Promise<FilteredCandidates> {
  const counts = new Map<MemoryPolicyFilter, number>();
  const authorized = await authorizedCandidates(input.context, input.authority, scopes, counts);
  const now = input.context.now();
  const exclusions: MemoryRecallExclusion[] = [];
  const eligible: RecallCandidate[] = [];
  const superseded: RecallCandidate[] = [];
  for (const candidate of authorized) {
    const verdict = policyVerdict(input, candidate, now);
    if (verdict !== undefined) {
      counts.set(verdict[0], (counts.get(verdict[0]) ?? 0) + 1);
      exclusions.push(recallExclusion(candidate, verdict[0], verdict[1]));
      continue;
    }
    if (!historicalAdmitted(input.plan, candidate)) {
      counts.set('supersession', (counts.get('supersession') ?? 0) + 1);
      exclusions.push(recallExclusion(candidate, 'supersession', 'superseded'));
      superseded.push(candidate);
      continue;
    }
    const constraint = constraintVerdict(input.plan, candidate);
    if (constraint !== undefined) {
      exclusions.push(recallExclusion(candidate, constraint[0], constraint[1]));
      continue;
    }
    eligible.push(candidate);
  }
  return {
    authorized,
    eligible,
    superseded,
    exclusions,
    filters: MEMORY_POLICY_FILTERS.map((filter) => ({ filter, excluded: counts.get(filter) ?? 0 })),
    constraintStages: appliedConstraintStages(input.plan),
  };
}

/**
 * Resolves a selected derived record's lineage source wherever it is stored,
 * including another collection, and returns it only when the same predicate,
 * policy filters, supersession rule, and constraint stages the recall applied
 * to its own candidates would have let it through.
 */
export async function resolveLineageSource(
  input: FilterInput,
  reference: RecordReference,
): Promise<RecallCandidate | undefined> {
  const resolved = await input.context.load(input.authority.tenantId, reference);
  if (resolved === undefined) return undefined;
  const decision = decideMemoryAccess(input.authority, 'search', resourceOf(resolved));
  if (!decision.allowed) return undefined;
  const candidate = candidateOf(resolved, decision.redaction);
  if (policyVerdict(input, candidate, input.context.now()) !== undefined) return undefined;
  if (!historicalAdmitted(input.plan, candidate)) return undefined;
  return constraintVerdict(input.plan, candidate) === undefined ? candidate : undefined;
}
