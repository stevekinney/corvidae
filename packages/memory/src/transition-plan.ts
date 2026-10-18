import {
  type EvidenceProjectionRecord,
  PROJECTION_PAYLOAD_SCHEMAS,
  PROJECTION_SCHEMA_VERSION,
  type ProjectionReference,
  type ProjectionSource,
} from './evidence-projection-schema';
import { EVIDENCE_SCHEMA_VERSION, type EvidenceRecord } from './evidence-schema';
import type {
  ConsolidateProposal,
  ProposedEvidence,
  ProposedProjection,
  ProposedRevision,
  TransitionProposal,
} from './transition-proposal';
import type { TransitionReader } from './transition-reader';

/** What a check reads: the proposal, the store as the submission saw it, and the instant it stamps with. */
export interface TransitionValidationContext {
  readonly proposal: TransitionProposal;
  readonly reader: TransitionReader;
  readonly at: number;
}

/** A revision the proposal asks for, with the current revision it was read against. */
export interface RevisionPlan {
  readonly namespace: string;
  readonly id: string;
  readonly expectedRevision: number;
  readonly changeKind: ProposedRevision['change']['kind'];
  readonly request: ProposedRevision;
  readonly current: EvidenceProjectionRecord | undefined;
  /**
   * The revision the proposal expected, read from history; the current revision
   * when the expected one does not exist, and `undefined` when the projection
   * does not exist at all. Every check reads this, so a proposal that is both
   * invalid and stale is refused for what is invalid.
   */
  readonly base: EvidenceProjectionRecord | undefined;
  /** Why the expected revision is not the current one, or `undefined` when it is. */
  readonly stale: string | undefined;
  /**
   * The record the revision would write, laid over `base`; `undefined` only when
   * the projection does not exist. A stale revision still has one, so the checks
   * run, and the engine reports the staleness once they pass.
   */
  readonly next: EvidenceProjectionRecord | undefined;
}

/** The consolidation's candidates and summary, as the receipt records them. */
export interface ConsolidationPlan {
  readonly candidates: readonly EvidenceProjectionRecord[];
  readonly summary: EvidenceProjectionRecord;
}

/** Everything a proposal would write, stamped. Pure data: nothing here has been validated or stored. */
export interface TransitionPlan {
  readonly evidence: readonly EvidenceRecord[];
  /** The evidence ids the proposal supersedes, in proposal order. */
  readonly supersededEvidence: readonly string[];
  /** Projections created at revision 1, in proposal order. */
  readonly created: readonly EvidenceProjectionRecord[];
  readonly revisions: readonly RevisionPlan[];
  readonly consolidation: ConsolidationPlan | undefined;
}

/** A proposal that cannot be turned into records at all. */
export class TransitionPlanError extends Error {
  constructor(
    readonly reason: 'malformed',
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'TransitionPlanError';
  }
}

export function projectionLabel(record: {
  namespace: string;
  id: string;
  revision?: number;
}): string {
  return record.revision === undefined
    ? `${record.namespace}/${record.id}`
    : `${record.namespace}/${record.id}@${record.revision}`;
}

function stampEvidence(proposed: ProposedEvidence, at: number): EvidenceRecord {
  return { ...proposed, schemaVersion: EVIDENCE_SCHEMA_VERSION, writtenAt: at };
}

/**
 * Stamps a created projection. The clock supplies `transition.at` and, only when
 * the proposal omits it, `validity.validFrom`; `validUntil` is never derived for
 * a created projection.
 */
function stampCreated(
  proposed: ProposedProjection,
  authorityPolicyRevision: string,
  at: number,
): EvidenceProjectionRecord {
  const { validity, supersedes, ...rest } = proposed;
  return {
    ...rest,
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    revision: 1,
    policyRevision: authorityPolicyRevision,
    status: 'active',
    validity: {
      validFrom: validity?.validFrom ?? at,
      ...(validity?.validUntil === undefined ? {} : { validUntil: validity.validUntil }),
    },
    transition: { kind: 'created', at, ...(supersedes === undefined ? {} : { supersedes }) },
  };
}

function mergedValidity(
  current: EvidenceProjectionRecord['validity'],
  proposed: ProposedRevision['validity'],
  derivedUntil: number | undefined,
): EvidenceProjectionRecord['validity'] {
  const validUntil = proposed?.validUntil ?? derivedUntil ?? current.validUntil;
  return {
    validFrom: proposed?.validFrom ?? current.validFrom,
    ...(validUntil === undefined ? {} : { validUntil }),
  };
}

/** The record one revision writes, laid over the current revision it expects. */
function stampRevision(
  current: EvidenceProjectionRecord,
  request: ProposedRevision,
  policyRevision: string,
  at: number,
): EvidenceProjectionRecord {
  const { change } = request;
  const base = {
    ...current,
    revision: current.revision + 1,
    policyRevision,
    confidence: request.confidence ?? current.confidence,
  };
  switch (change.kind) {
    case 'demoted':
      return {
        ...base,
        status: 'demoted',
        validity: mergedValidity(current.validity, request.validity, undefined),
        transition: { kind: 'demoted', at, demotedBy: change.demotedBy },
      };
    case 'superseded':
      return {
        ...base,
        status: 'superseded',
        validity: mergedValidity(current.validity, request.validity, at),
        transition: { kind: 'superseded', at, supersededBy: change.supersededBy },
      };
    case 'revoked':
      return {
        ...base,
        status: 'revoked',
        validity: mergedValidity(current.validity, request.validity, at),
        transition: { kind: 'revoked', at, reasonCode: change.reasonCode },
      };
    case 'rebuilt': {
      const payload = PROJECTION_PAYLOAD_SCHEMAS[current.kind].safeParse(change.payload);
      if (!payload.success) {
        throw new TransitionPlanError(
          'malformed',
          `The rebuilt payload of ${projectionLabel(current)} does not fit a ${current.kind}: ${payload.error.issues
            .slice(0, 2)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ')}`,
        );
      }
      const { embedding: _embedding, ...withoutEmbedding } = base;
      return {
        ...withoutEmbedding,
        status: 'active',
        projectorRevision: change.projectorRevision ?? current.projectorRevision,
        confidence: change.confidence ?? request.confidence ?? current.confidence,
        sources: change.sources,
        payload: payload.data,
        ...(change.embedding === undefined ? {} : { embedding: change.embedding }),
        validity: mergedValidity(current.validity, request.validity, undefined),
        transition: { kind: 'rebuilt', at, rebuiltFromRevision: current.revision },
      } as EvidenceProjectionRecord;
    }
  }
}

async function planRevision(
  request: ProposedRevision,
  reader: TransitionReader,
  policyRevision: string,
  at: number,
): Promise<RevisionPlan> {
  const { namespace, id, expectedRevision } = request;
  const current = await reader.projection(namespace, id);
  const shared = {
    namespace,
    id,
    expectedRevision,
    changeKind: request.change.kind,
    request,
    current,
  };
  if (current === undefined) {
    return {
      ...shared,
      base: undefined,
      stale: `${projectionLabel(request)} has no stored revision; the proposal expected revision ${expectedRevision}.`,
      next: undefined,
    };
  }
  const base =
    current.revision === expectedRevision
      ? current
      : ((await reader.projectionRevision(namespace, id, expectedRevision)) ?? current);
  const stale =
    current.revision === expectedRevision
      ? undefined
      : `${projectionLabel(request)} is at revision ${current.revision}; the proposal expected revision ${expectedRevision}.`;
  return { ...shared, base, stale, next: stampRevision(base, request, policyRevision, at) };
}

/** The revisions a consolidation asks for: each candidate is retired in favour of the summary. */
function consolidationRevisions(proposal: ConsolidateProposal): ProposedRevision[] {
  const by: ProjectionReference = { id: proposal.summary.id, revision: 1 };
  return proposal.candidates.map((candidate): ProposedRevision => ({
    namespace: proposal.namespace,
    id: candidate.id,
    expectedRevision: candidate.revision,
    change:
      proposal.outcome === 'supersede'
        ? { kind: 'superseded', supersededBy: by }
        : { kind: 'demoted', demotedBy: by },
  }));
}

/**
 * The summary a consolidation creates: it covers the candidates, carries the
 * union of their evidence sources in candidate order, and (only when the
 * candidates are superseded) names them in `transition.supersedes`. Its
 * confidence defaults to the weakest candidate's.
 */
function buildSummary(
  proposal: ConsolidateProposal,
  candidates: readonly EvidenceProjectionRecord[],
  at: number,
): EvidenceProjectionRecord {
  const sources = new Map<string, ProjectionSource>();
  for (const candidate of candidates) {
    for (const source of candidate.sources) {
      if (!sources.has(source.evidenceId)) sources.set(source.evidenceId, source);
    }
  }
  // The revisions the proposal names, not the ones a stale read found, so both sides agree.
  const covers = proposal.candidates.map(({ id, revision }) => ({ id, revision }));
  const { summary } = proposal;
  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    id: summary.id,
    tenantId: proposal.tenantId,
    namespace: proposal.namespace,
    kind: 'summary',
    revision: 1,
    projectorRevision: proposal.projectorRevision,
    policyRevision: proposal.authority.policyRevision,
    sources: [...sources.values()],
    validity: { validFrom: at },
    confidence:
      summary.confidence ?? Math.min(...candidates.map((candidate) => candidate.confidence)),
    status: 'active',
    transition:
      proposal.outcome === 'supersede'
        ? { kind: 'created', at, supersedes: covers }
        : { kind: 'created', at },
    ...(summary.embedding === undefined ? {} : { embedding: summary.embedding }),
    payload: { text: summary.text, covers },
  };
}

/**
 * Turns a proposal into the records it would write, stamping the clock-derived
 * fields with `at` and reading each current revision a revision expects.
 * A revision whose expected revision is not the current one is carried as stale
 * with no `next`; the engine reports it as a conflict once validation passes.
 */
export async function buildTransitionPlan(
  proposal: TransitionProposal,
  reader: TransitionReader,
  at: number,
): Promise<TransitionPlan> {
  const { policyRevision } = proposal.authority;
  const stamp = (projection: ProposedProjection) => stampCreated(projection, policyRevision, at);
  switch (proposal.kind) {
    case 'append-evidence':
      return {
        evidence: proposal.evidence.map((record) => stampEvidence(record, at)),
        supersededEvidence: [],
        created: [],
        revisions: [],
        consolidation: undefined,
      };
    case 'create-projection':
      return {
        evidence: [],
        supersededEvidence: [],
        created: proposal.projections.map(stamp),
        revisions: [],
        consolidation: undefined,
      };
    case 'revise-projection':
      return {
        evidence: [],
        supersededEvidence: [],
        created: [],
        revisions: await Promise.all(
          proposal.revisions.map((request) => planRevision(request, reader, policyRevision, at)),
        ),
        consolidation: undefined,
      };
    case 'correct-evidence':
      return {
        evidence: [stampEvidence(proposal.successor, at)],
        supersededEvidence: proposal.successor.supersedes ?? [],
        created: (proposal.projections ?? []).map(stamp),
        revisions: await Promise.all(
          (proposal.revisions ?? []).map((request) =>
            planRevision(request, reader, policyRevision, at),
          ),
        ),
        consolidation: undefined,
      };
    case 'consolidate': {
      const revisions = await Promise.all(
        consolidationRevisions(proposal).map((request) =>
          planRevision(request, reader, policyRevision, at),
        ),
      );
      const candidates = revisions.flatMap((revision) =>
        revision.base === undefined ? [] : [revision.base],
      );
      if (candidates.length !== revisions.length) {
        return {
          evidence: [],
          supersededEvidence: [],
          created: [],
          revisions,
          consolidation: undefined,
        };
      }
      const summary = buildSummary(proposal, candidates, at);
      return {
        evidence: [],
        supersededEvidence: [],
        created: [summary],
        revisions,
        consolidation: { candidates: candidates, summary },
      };
    }
  }
}

/** Every projection record the plan writes, in commit order: created first, then each revision. */
export function plannedProjections(plan: TransitionPlan): EvidenceProjectionRecord[] {
  return [
    ...plan.created,
    ...plan.revisions.flatMap((revision) => (revision.next === undefined ? [] : [revision.next])),
  ];
}
