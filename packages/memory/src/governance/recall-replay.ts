import type { MemoryEvidenceKind } from './evidence';
import type { MemoryEvidenceBundle, MemoryRecallExclusionReason } from './governed-memory-types';
import type { MemoryRecallStopReason } from './retrieval-plan';

/**
 * What a replay of a recall must reproduce: the revisions it ran under, which
 * records it selected, in order and at which record revisions, and why it left
 * each other authorized candidate out. It holds identifiers and digests only,
 * never content, so a manifest can be stored beside a test or an audit record.
 */
export interface MemoryEvidenceManifest {
  readonly revision: string;
  readonly planRevision: string;
  readonly policyRevision: string;
  readonly queryDigest: string;
  readonly stopReason: MemoryRecallStopReason;
  readonly evidence: readonly {
    readonly recordId: string;
    readonly revision: string;
    readonly kind: MemoryEvidenceKind;
  }[];
  readonly exclusions: readonly {
    readonly recordId: string;
    readonly revision: string;
    readonly reason: MemoryRecallExclusionReason;
  }[];
}

/**
 * One named, deterministic way a replayed recall differs from the recorded
 * one. A replay that reports none reproduced the recorded manifest exactly.
 */
export type MemoryRecallDifference =
  | { readonly kind: 'plan-revision'; readonly recorded: string; readonly replayed: string }
  /**
   * The bundle revisions differ though no other difference names why, for
   * example an evidence kind changed or exclusions were reordered. The bundle
   * revision digests every input to the bundle, so this guard means a replay
   * can never pass while its bundle differs from the recorded one.
   */
  | { readonly kind: 'bundle-revision'; readonly recorded: string; readonly replayed: string }
  | { readonly kind: 'policy-revision'; readonly recorded: string; readonly replayed: string }
  | { readonly kind: 'query'; readonly recorded: string; readonly replayed: string }
  | {
      readonly kind: 'stop-reason';
      readonly recorded: MemoryRecallStopReason;
      readonly replayed: MemoryRecallStopReason;
    }
  | {
      readonly kind: 'record-revision';
      readonly recordId: string;
      readonly recorded: string;
      readonly replayed: string;
    }
  | { readonly kind: 'evidence-added'; readonly recordId: string }
  | { readonly kind: 'evidence-removed'; readonly recordId: string }
  | {
      readonly kind: 'evidence-order';
      readonly recorded: readonly string[];
      readonly replayed: readonly string[];
    }
  | {
      readonly kind: 'exclusion';
      readonly recordId: string;
      readonly recorded: MemoryRecallExclusionReason | undefined;
      readonly replayed: MemoryRecallExclusionReason | undefined;
    };

/** The manifest of one bundle. */
export function memoryEvidenceManifest(bundle: MemoryEvidenceBundle): MemoryEvidenceManifest {
  const revisions = new Map(bundle.candidates.map((item) => [item.recordId, item.revision]));
  return {
    revision: bundle.revision,
    planRevision: bundle.planRevision,
    policyRevision: bundle.policyRevision,
    queryDigest: bundle.queryDigest,
    stopReason: bundle.stopReason,
    evidence: bundle.evidence.map((item) => ({
      recordId: item.id,
      revision: revisions.get(item.id) ?? '',
      kind: item.kind,
    })),
    exclusions: bundle.exclusions.map(({ recordId, revision, reason }) => ({
      recordId,
      revision,
      reason,
    })),
  };
}

function scalarDifferences(
  recorded: MemoryEvidenceManifest,
  replayed: MemoryEvidenceManifest,
): MemoryRecallDifference[] {
  const differences: MemoryRecallDifference[] = [];
  if (recorded.planRevision !== replayed.planRevision) {
    differences.push({
      kind: 'plan-revision',
      recorded: recorded.planRevision,
      replayed: replayed.planRevision,
    });
  }
  if (recorded.policyRevision !== replayed.policyRevision) {
    differences.push({
      kind: 'policy-revision',
      recorded: recorded.policyRevision,
      replayed: replayed.policyRevision,
    });
  }
  if (recorded.queryDigest !== replayed.queryDigest) {
    differences.push({
      kind: 'query',
      recorded: recorded.queryDigest,
      replayed: replayed.queryDigest,
    });
  }
  if (recorded.stopReason !== replayed.stopReason) {
    differences.push({
      kind: 'stop-reason',
      recorded: recorded.stopReason,
      replayed: replayed.stopReason,
    });
  }
  return differences;
}

function evidenceDifferences(
  recorded: MemoryEvidenceManifest,
  replayed: MemoryEvidenceManifest,
): MemoryRecallDifference[] {
  const differences: MemoryRecallDifference[] = [];
  const before = new Map(recorded.evidence.map((item) => [item.recordId, item.revision]));
  const after = new Map(replayed.evidence.map((item) => [item.recordId, item.revision]));
  for (const [recordId, revision] of before) {
    const replayedRevision = after.get(recordId);
    if (replayedRevision === undefined) differences.push({ kind: 'evidence-removed', recordId });
    else if (replayedRevision !== revision) {
      differences.push({
        kind: 'record-revision',
        recordId,
        recorded: revision,
        replayed: replayedRevision,
      });
    }
  }
  for (const recordId of after.keys()) {
    if (!before.has(recordId)) differences.push({ kind: 'evidence-added', recordId });
  }
  const shared = (ids: readonly string[], other: ReadonlyMap<string, string>) =>
    ids.filter((id) => other.has(id));
  const recordedOrder = shared([...before.keys()], after);
  const replayedOrder = shared([...after.keys()], before);
  if (recordedOrder.join('\n') !== replayedOrder.join('\n')) {
    differences.push({ kind: 'evidence-order', recorded: recordedOrder, replayed: replayedOrder });
  }
  return differences;
}

function exclusionDifferences(
  recorded: MemoryEvidenceManifest,
  replayed: MemoryEvidenceManifest,
): MemoryRecallDifference[] {
  const before = new Map(recorded.exclusions.map((item) => [item.recordId, item]));
  const after = new Map(replayed.exclusions.map((item) => [item.recordId, item]));
  const recordIds = [...new Set([...before.keys(), ...after.keys()])];
  return recordIds.flatMap((recordId): MemoryRecallDifference[] => {
    const was = before.get(recordId);
    const now = after.get(recordId);
    // An excluded record whose content changed is a difference even when its reason did not.
    if (was !== undefined && now !== undefined && was.reason === now.reason) {
      return was.revision === now.revision
        ? []
        : [{ kind: 'record-revision', recordId, recorded: was.revision, replayed: now.revision }];
    }
    return [
      {
        kind: 'exclusion',
        recordId,
        recorded: was?.reason,
        replayed: now?.reason,
      },
    ];
  });
}

/**
 * Compares a replayed recall's manifest with the recorded one and names every
 * difference, in a fixed order: revisions and stop reason, then the selected
 * evidence, then the exclusions, and finally the bundle revision itself when
 * nothing earlier explains a difference in it. An empty list therefore means
 * the replay reproduced the recorded bundle exactly.
 */
export function compareMemoryEvidenceManifests(
  recorded: MemoryEvidenceManifest,
  replayed: MemoryEvidenceManifest,
): MemoryRecallDifference[] {
  const differences = [
    ...scalarDifferences(recorded, replayed),
    ...evidenceDifferences(recorded, replayed),
    ...exclusionDifferences(recorded, replayed),
  ];
  if (differences.length === 0 && recorded.revision !== replayed.revision) {
    differences.push({
      kind: 'bundle-revision',
      recorded: recorded.revision,
      replayed: replayed.revision,
    });
  }
  return differences;
}
