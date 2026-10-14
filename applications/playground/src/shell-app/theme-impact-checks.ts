/**
 * The checks a proposal would change (COR-488). The accessibility report engine runs on the
 * current revision and on the proposed state, both across all six contexts, and the findings
 * are compared by their stable ids: a finding only the proposal has is introduced, and one
 * only the current revision has is resolved. Severities stay separate, as the report keeps
 * them, and a proposal that makes the source invalid says so by the runtime's own diagnostics.
 *
 * This is the expensive part of a proposal (two reports), so it is computed on request from
 * the proposal's "Check this change" action, never on the edit-commit path.
 */

import { buildAccessibilityReport, reportFindings } from './theme-check-engine.ts';
import { SEVERITIES, type ReportRecord, type Severity } from './theme-check-types.ts';
import type { ThemeEvaluation, ThemeEvaluator } from './theme-draft-evaluation.ts';
import {
  THEME_CONTEXT_IDS,
  type EditableState,
  type ThemeContextId,
  type ThemeEnvelope,
} from './theme-draft-types.ts';
import { defaultThemeEvaluator } from './theme-runtime-evaluator.ts';

/** One evaluator for every proposal, so the current revision's contexts are evaluated once. */
export const checksEvaluator: ThemeEvaluator = {
  evaluate: (source, revision, context) =>
    defaultThemeEvaluator().evaluate(source, revision, context),
};

export type FindingSummary = {
  id: string;
  severity: Severity;
  message: string;
  tokenPaths: readonly string[];
  context: ThemeContextId;
};

export type SeverityDelta = {
  severity: Severity;
  introduced: readonly FindingSummary[];
  resolved: readonly FindingSummary[];
};

export type ChecksDelta =
  | {
      ok: true;
      /** One entry per severity, in the report's order, even when both lists are empty. */
      bySeverity: readonly SeverityDelta[];
      introduced: number;
      resolved: number;
    }
  | { ok: false; message: string };

async function evaluations(
  evaluator: ThemeEvaluator,
  envelope: ThemeEnvelope,
): Promise<Partial<Record<ThemeContextId, ThemeEvaluation>>> {
  const out: Partial<Record<ThemeContextId, ThemeEvaluation>> = {};
  for (const context of THEME_CONTEXT_IDS) {
    out[context] = await evaluator.evaluate(envelope, 0, context);
  }
  return out;
}

function findingsOf(records: readonly ReportRecord[]): Map<string, FindingSummary> {
  const found = new Map<string, FindingSummary>();
  for (const record of records) {
    if (record.severity === null) continue;
    found.set(`${record.id}|${record.severity}`, {
      id: record.id,
      severity: record.severity,
      message: record.message,
      tokenPaths: record.tokenPaths,
      context: record.context,
    });
  }
  return found;
}

async function findingsFor(
  evaluator: ThemeEvaluator,
  envelope: ThemeEnvelope,
): Promise<Map<string, FindingSummary> | string> {
  const report = buildAccessibilityReport({
    themeId: envelope.id,
    sourceRevision: 0,
    evaluations: await evaluations(evaluator, envelope),
  });
  if (report.sourceValidity.status === 'invalid') {
    const [first] = report.sourceValidity.diagnostics;
    return `${first?.path ?? '$'}: ${first?.message ?? 'The source is invalid.'}`;
  }
  return findingsOf(reportFindings(report));
}

/** The findings `state` introduces and resolves relative to `envelope`. */
export async function computeChecksDelta(
  evaluator: ThemeEvaluator,
  envelope: ThemeEnvelope,
  state: EditableState,
): Promise<ChecksDelta> {
  const proposed: ThemeEnvelope = {
    ...envelope,
    overrides: state.overrides,
    cssOverrides: state.cssOverrides,
  };
  const before = await findingsFor(evaluator, envelope);
  const after = await findingsFor(evaluator, proposed);
  if (typeof after === 'string') return { ok: false, message: after };
  const current = typeof before === 'string' ? new Map<string, FindingSummary>() : before;
  const bySeverity = SEVERITIES.map((severity): SeverityDelta => {
    const introduced = [...after].filter(([key]) => !current.has(key)).map(([, value]) => value);
    const resolved = [...current].filter(([key]) => !after.has(key)).map(([, value]) => value);
    return {
      severity,
      introduced: introduced.filter((finding) => finding.severity === severity),
      resolved: resolved.filter((finding) => finding.severity === severity),
    };
  });
  return {
    ok: true,
    bySeverity,
    introduced: bySeverity.reduce((sum, entry) => sum + entry.introduced.length, 0),
    resolved: bySeverity.reduce((sum, entry) => sum + entry.resolved.length, 0),
  };
}
