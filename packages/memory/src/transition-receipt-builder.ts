import {
  encodeEvidenceProjectionRecord,
  type EvidenceProjectionRecord,
} from './evidence-projection-schema';
import { digestOfText, encodeEvidenceRecord } from './evidence-schema';
import { plannedProjections, type TransitionPlan } from './transition-plan';
import type { TransitionProposal } from './transition-proposal';
import type { TransitionReader } from './transition-reader';
import {
  digestOfBytes,
  TRANSITION_RECEIPT_SCHEMA_VERSION,
  type TransitionReceipt,
  type TransitionValidationCheck,
} from './transition-receipt';

type EvidenceOutcome = TransitionReceipt['evidence'][number]['outcome'];
type ProjectionOutcome = TransitionReceipt['projections'][number]['outcome'];

/** What `commit()` is expected to report for each record, in commit order. */
export interface PredictedOutcomes {
  readonly evidence: readonly EvidenceOutcome[];
  readonly projections: readonly ProjectionOutcome[];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Predicts, from the reads validation made, which records `commit()` will
 * report as already stored byte for byte. The receipt is written in the same
 * batch as the records, so it must be built before `commit()` can say; the
 * engine compares this against the commit's own report afterward.
 */
export async function predictOutcomes(
  plan: TransitionPlan,
  reader: TransitionReader,
): Promise<PredictedOutcomes> {
  const evidence: EvidenceOutcome[] = [];
  for (const record of plan.evidence) {
    const stored = await reader.evidence(record.id);
    evidence.push(
      stored !== undefined && bytesEqual(encodeEvidenceRecord(stored), encodeEvidenceRecord(record))
        ? 'duplicate'
        : 'appended',
    );
  }
  const projections: ProjectionOutcome[] = [];
  for (const record of plannedProjections(plan)) {
    const stored = await reader.projection(record.namespace, record.id);
    projections.push(
      stored !== undefined &&
        bytesEqual(encodeEvidenceProjectionRecord(stored), encodeEvidenceProjectionRecord(record))
        ? 'duplicate'
        : 'written',
    );
  }
  return { evidence, projections };
}

function digestOfProjection(record: EvidenceProjectionRecord): string {
  return digestOfBytes(encodeEvidenceProjectionRecord(record));
}

function projectionOutcome(
  record: EvidenceProjectionRecord,
  outcome: ProjectionOutcome,
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

export function buildReceipt(input: {
  readonly proposal: TransitionProposal;
  readonly plan: TransitionPlan;
  readonly digest: string;
  readonly checks: readonly TransitionValidationCheck[];
  readonly predicted: PredictedOutcomes;
  readonly requestedAt: number;
  readonly committedAt: number;
}): TransitionReceipt {
  const { proposal, plan, predicted } = input;
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
      outcome: predicted.evidence[index]!,
      ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes }),
    })),
    projections: plannedProjections(plan).map((record, index) =>
      projectionOutcome(record, predicted.projections[index]!),
    ),
    ...(proposal.kind === 'consolidate'
      ? { consolidation: consolidationRecord(proposal, plan) }
      : {}),
  };
}
