/**
 * The regression check every remediation proposal passes before it is offered and again
 * before it is applied (COR-487). The candidate state is evaluated in all six contexts and
 * the accessibility report is rebuilt for it; the proposal stands only if
 *
 * - the finding it is about is resolved,
 * - no finding of any severity is introduced (compared by stable id and severity),
 * - the candidate source is valid, and
 * - every context of the OTHER color mode has exactly the property map it had before.
 *
 * Contexts of the same color mode that differ only by motion share the color overrides, so
 * they move together; that is stated in the proposal's notes rather than hidden.
 */

import { buildAccessibilityReport, reportFindings } from './theme-check-engine.ts';
import type { AccessibilityReport, ReportRecord, Severity } from './theme-check-types.ts';
import type { ThemeEvaluation, ThemeEvaluator } from './theme-draft-evaluation.ts';
import {
  THEME_CONTEXT_IDS,
  type EditableState,
  type ThemeContextId,
  type ThemeEnvelope,
} from './theme-draft-types.ts';

export type EvaluatedContexts = Readonly<Partial<Record<ThemeContextId, ThemeEvaluation>>>;

export type StateReport = {
  report: AccessibilityReport;
  evaluations: EvaluatedContexts;
};

/** The envelope a state describes: identity and base unchanged, editable state replaced. */
export function envelopeWith(envelope: ThemeEnvelope, state: EditableState): ThemeEnvelope {
  const { locked: _previous, ...rest } = envelope;
  return {
    ...rest,
    overrides: state.overrides,
    cssOverrides: state.cssOverrides,
    ...(state.locked === undefined ? {} : { locked: state.locked }),
  };
}

export async function reportForEnvelope(
  evaluator: ThemeEvaluator,
  envelope: ThemeEnvelope,
  revision: number,
): Promise<StateReport> {
  const evaluations: Partial<Record<ThemeContextId, ThemeEvaluation>> = {};
  for (const context of THEME_CONTEXT_IDS) {
    evaluations[context] = await evaluator.evaluate(envelope, revision, context);
  }
  return {
    report: buildAccessibilityReport({
      themeId: envelope.id,
      sourceRevision: revision,
      evaluations,
    }),
    evaluations,
  };
}

export type FindingKey = `${string}|${Severity}`;

export function findingKeys(report: AccessibilityReport): Map<FindingKey, ReportRecord> {
  const keys = new Map<FindingKey, ReportRecord>();
  for (const record of reportFindings(report)) {
    if (record.severity !== null) keys.set(`${record.id}|${record.severity}`, record);
  }
  return keys;
}

export const findingKey = (record: ReportRecord): FindingKey =>
  `${record.id}|${record.severity ?? 'advisory'}`;

export type CheckOutcome =
  | { ok: true; resolved: number; introduced: 0; unchangedContexts: number }
  | { ok: false; message: string };

const mapOf = (evaluation: ThemeEvaluation | undefined): string =>
  evaluation === undefined || !evaluation.ok
    ? 'invalid'
    : JSON.stringify(
        evaluation.properties.map(({ name, value }) => [name, value]).toSorted(([a], [b]) =>
          String(a).localeCompare(String(b)),
        ),
      );

/** Contexts of the other color mode whose property map differs between two evaluations. */
export function changedOtherModeContexts(
  colorMode: string,
  before: EvaluatedContexts,
  after: EvaluatedContexts,
): ThemeContextId[] {
  return THEME_CONTEXT_IDS.filter(
    (context) =>
      !context.startsWith(`${colorMode}/`) && mapOf(before[context]) !== mapOf(after[context]),
  );
}

/** Compare the candidate with the current revision; `target` is the finding being fixed. */
export function compareStates(
  current: StateReport,
  proposed: StateReport,
  target: { key: FindingKey | null; colorMode: string },
): CheckOutcome {
  if (proposed.report.sourceValidity.status === 'invalid') {
    const [first] = proposed.report.sourceValidity.diagnostics;
    return {
      ok: false,
      message: `The change would make the source invalid: ${first?.path ?? '$'}: ${first?.message ?? 'not valid'}.`,
    };
  }
  const before = findingKeys(current.report);
  const after = findingKeys(proposed.report);
  const introduced = [...after].filter(([key]) => !before.has(key));
  if (introduced.length > 0) {
    const named = introduced
      .slice(0, 3)
      .map(([, record]) => `${record.message} (${record.context})`)
      .join(' ');
    return {
      ok: false,
      message: `The change would introduce ${introduced.length} new ${introduced.length === 1 ? 'finding' : 'findings'}. ${named}`,
    };
  }
  const moved = changedOtherModeContexts(
    target.colorMode,
    current.evaluations,
    proposed.evaluations,
  );
  if (moved.length > 0) {
    return {
      ok: false,
      message: `The change would also alter ${moved.join(', ')}, which this fix must leave untouched.`,
    };
  }
  if (target.key !== null && after.has(target.key)) {
    return { ok: false, message: 'The change would not resolve this finding.' };
  }
  const resolved = [...before].filter(([key]) => !after.has(key)).length;
  return { ok: true, resolved, introduced: 0, unchangedContexts: THEME_CONTEXT_IDS.length };
}
