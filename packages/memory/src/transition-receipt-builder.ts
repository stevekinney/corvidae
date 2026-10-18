import {
  encodeEvidenceProjectionRecord,
  type EvidenceProjectionRecord,
} from './evidence-projection-schema';
import type { EvidenceProjectionCommitResult } from './evidence-projection-storage';
import { digestOfText } from './evidence-schema';
import { plannedProjections, type TransitionPlan } from './transition-plan';
import type { TransitionProposal } from './transition-proposal';
import {
  digestOfBytes,
  TRANSITION_RECEIPT_SCHEMA_VERSION,
  type TransitionReceipt,
  type TransitionValidationCheck,
} from './transition-receipt';

function digestOfProjection(record: EvidenceProjectionRecord): string {
  return digestOfBytes(encodeEvidenceProjectionRecord(record));
}

function projectionOutcome(
  record: EvidenceProjectionRecord,
  outcome: TransitionReceipt['projections'][number]['outcome'],
): TransitionReceipt['projections'][number] {
  const { transition } = record;
  return {
    namespace: record.namespace,
    id: record.id,
    revision: record.revision,
    recordDigest: digestOfProjection(record),
    transition: transition.kind,
    outcome,
    ...(transition.kind === 'created' && transition.supersedes !== undefined
      ? { supersedes: transition.supersedes }
      : {}),
    ...(transition.kind === 'superseded' ? { supersededBy: transition.supersededBy } : {}),
    ...(transition.kind === 'demoted' ? { demotedBy: transition.demotedBy } : {}),
  };
}

function consolidationRecord(
  proposal: Extract<TransitionProposal, { kind: 'consolidate' }>,
  plan: TransitionPlan,
): NonNullable<TransitionReceipt['consolidation']> {
  const { consolidation } = plan;
  if (consolidation === undefined) {
    throw new Error('A consolidation receipt needs its candidates and summary.');
  }
  const { summary } = consolidation;
  const retired = plan.revisions.flatMap((revision) =>
    revision.next === undefined ||
    (revision.next.transition.kind !== 'superseded' && revision.next.transition.kind !== 'demoted')
      ? []
      : [
          {
            id: revision.id,
            revision: revision.next.revision,
            transition: revision.next.transition.kind,
          },
        ],
  );
  return {
    candidates: consolidation.candidates.map((candidate) => ({
      id: candidate.id,
      revision: candidate.revision,
      recordDigest: digestOfProjection(candidate),
    })),
    outcome: proposal.outcome,
    projectorRevision: proposal.projectorRevision,
    promptRevision: proposal.promptRevision,
    summary: {
      id: summary.id,
      revision: 1,
      recordDigest: digestOfProjection(summary),
      textDigest: digestOfText(proposal.summary.text),
    },
    retired,
  };
}

/**
 * Builds the receipt for one planning attempt of the commit. `outcomes` are the
 * attempt's own per-record outcomes, in commit order, so each `outcome` field
 * records what the batch carrying this receipt did, never a prediction.
 */
export function buildReceipt(input: {
  readonly proposal: TransitionProposal;
  readonly plan: TransitionPlan;
  readonly digest: string;
  readonly checks: readonly TransitionValidationCheck[];
  readonly outcomes: EvidenceProjectionCommitResult;
  readonly requestedAt: number;
  readonly committedAt: number;
}): TransitionReceipt {
  const { proposal, plan, outcomes } = input;
  return {
    schemaVersion: TRANSITION_RECEIPT_SCHEMA_VERSION,
    operationId: proposal.operationId,
    tenantId: proposal.tenantId,
    kind: proposal.kind,
    digest: input.digest,
    authority: proposal.authority,
    outcome: 'committed',
    requestedAt: input.requestedAt,
    committedAt: input.committedAt,
    validation: { checks: [...input.checks], policyRevision: proposal.authority.policyRevision },
    evidence: plan.evidence.map((record, index) => ({
      id: record.id,
      digest: record.digest,
      outcome: outcomes.evidence[index]!.outcome,
      ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes }),
    })),
    projections: plannedProjections(plan).map((record, index) =>
      projectionOutcome(record, outcomes.projections[index]!.outcome),
    ),
    ...(proposal.kind === 'consolidate'
      ? { consolidation: consolidationRecord(proposal, plan) }
      : {}),
  };
}
