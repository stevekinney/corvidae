/**
 * The exact checked state an export is built from (COR-486). Export never reads the live
 * draft: it takes one revision of one envelope, evaluates all six contexts, runs the
 * accessibility report on those evaluations, and every artifact is made from that snapshot.
 * Editing afterwards cannot change what was checked, and a snapshot whose revision is no
 * longer the draft's is stale and is rebuilt rather than exported.
 */

import { isShippedBase } from './theme-builder-base.ts';
import { buildAccessibilityReport, countReport, exportReadiness } from './theme-check-engine.ts';
import type { AccessibilityReport, ExportReadiness, ReportCounts } from './theme-check-types.ts';
import type { ThemeEvaluation, ThemeEvaluator } from './theme-draft-evaluation.ts';
import {
  THEME_CONTEXT_IDS,
  type ThemeContextId,
  type ThemeDraft,
  type ThemeEnvelope,
} from './theme-draft-types.ts';

export type ExportSnapshot = {
  envelope: ThemeEnvelope;
  revision: number;
  evaluations: Readonly<Record<ThemeContextId, ThemeEvaluation>>;
  report: AccessibilityReport;
  readiness: ExportReadiness;
  counts: ReportCounts;
  /** False when the embedded Cinder base is not the one this build ships: nothing evaluates. */
  baseIsCurrent: boolean;
  /** True when every context evaluated, so the sources are valid. */
  sourceIsValid: boolean;
};

/** Evaluate and check one committed revision. */
export async function takeExportSnapshot(
  draft: ThemeDraft,
  evaluator: ThemeEvaluator,
): Promise<ExportSnapshot> {
  const { envelope, revision } = draft;
  const entries = await Promise.all(
    THEME_CONTEXT_IDS.map(
      async (context) => [context, await evaluator.evaluate(envelope, revision, context)] as const,
    ),
  );
  const evaluations = Object.fromEntries(entries) as Record<ThemeContextId, ThemeEvaluation>;
  const report = buildAccessibilityReport({
    themeId: envelope.id,
    sourceRevision: revision,
    evaluations,
  });
  return {
    envelope,
    revision,
    evaluations,
    report,
    readiness: exportReadiness(report, true, false),
    counts: countReport(report),
    baseIsCurrent: isShippedBase(envelope.base),
    sourceIsValid: entries.every(([, evaluation]) => evaluation.ok),
  };
}

/** True while the snapshot still describes the draft it was taken from. */
export function snapshotIsCurrent(snapshot: ExportSnapshot, draft: ThemeDraft | null): boolean {
  return (
    draft !== null &&
    draft.envelope.id === snapshot.envelope.id &&
    draft.revision === snapshot.revision
  );
}
