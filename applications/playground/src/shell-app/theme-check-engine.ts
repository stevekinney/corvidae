/**
 * The accessibility report engine (COR-259).
 *
 * A report is built from the evaluations of ALL six contexts of one committed revision. It is
 * stamped with the theme, the revision and the contexts, and a consumer shows it as current
 * only while that stamp matches the draft (`isReportCurrent`), so an edit can never leave a
 * stale Pass on screen.
 *
 * Four outcome sets are produced and kept apart: source validity, the Cinder profile, WCAG
 * results and advisory results. Contrast comes from the shared runtime's pairing table and
 * measurement, so the CLI suites and the builder agree.
 */

import {
  AUTHORING_CATALOGUE,
  CONTRAST_PAIRINGS,
  measurePairing,
  profileRangeViolation,
  requiredContrast,
  type ContrastPairing,
  type PairingMeasurement,
} from '@lostgradient/cinder/tokens/runtime';

import {
  borderHierarchyRecords,
  chartDistinguishabilityRecords,
  pairingAdvisories,
  type RecordContext,
} from './theme-check-advisory.ts';
import { ruleById } from './theme-check-rules.ts';
import { sceneSitesFor } from './theme-check-scenes.ts';
import {
  type AccessibilityReport,
  type ExportReadiness,
  type ReportCounts,
  type ReportRecord,
  type Severity,
  type SourceValidityOutcome,
  type StackEntry,
} from './theme-check-types.ts';
import type { ThemeEvaluation } from './theme-draft-evaluation.ts';
import { THEME_CONTEXT_IDS, type ThemeContextId } from './theme-draft-types.ts';

const tokenPaths = new Map(
  AUTHORING_CATALOGUE.records.map((record) => [record.cssProperty, record.path] as const),
);
const profileByProperty = new Map(
  AUTHORING_CATALOGUE.records.map((record) => [
    record.cssProperty,
    AUTHORING_CATALOGUE.profiles[record.profile],
  ]),
);

export const tokenPathForProperty = (cssProperty: string): string | null =>
  tokenPaths.get(cssProperty) ?? null;

export type ReportInput = {
  themeId: string;
  sourceRevision: number;
  /** One evaluation per context; a missing one means the report cannot be produced. */
  evaluations: Readonly<Partial<Record<ThemeContextId, ThemeEvaluation>>>;
};

const UNTESTED_ALWAYS = [
  'Images, gradients and unknown backgrounds are not measured; they are reported as Needs review when a pairing reaches one.',
  'Rendered criteria (resize, reflow, text spacing, keyboard, focus, target size, forced colors, reduced motion) are checked in the browser suite, not by this report.',
  'Coverage of the listed scenes does not prove every component combination.',
];

function sourceValidity(evaluations: ReportInput['evaluations']): {
  outcome: SourceValidityOutcome;
  evaluated: Map<ThemeContextId, Record<string, string>>;
} {
  const diagnostics: Array<{ context: ThemeContextId; path: string; message: string }> = [];
  const evaluated = new Map<ThemeContextId, Record<string, string>>();
  for (const context of THEME_CONTEXT_IDS) {
    const evaluation = evaluations[context];
    if (evaluation === undefined) {
      diagnostics.push({ context, path: '$', message: 'This context was not evaluated.' });
    } else if (!evaluation.ok) {
      for (const diagnostic of evaluation.diagnostics) {
        diagnostics.push({ context, path: diagnostic.path, message: diagnostic.message });
      }
    } else {
      evaluated.set(
        context,
        Object.fromEntries(evaluation.properties.map(({ name, value }) => [name, value])),
      );
    }
  }
  return {
    outcome: diagnostics.length === 0 ? { status: 'valid' } : { status: 'invalid', diagnostics },
    evaluated,
  };
}

export function recordForPairing(
  pairing: ContrastPairing,
  measurement: PairingMeasurement,
  context: RecordContext,
): ReportRecord {
  const scenes = sceneSitesFor(pairing.group);
  const advisoryScope = pairing.scope === 'cinder-advisory';
  const required = advisoryScope
    ? (pairing.advisoryFloor ?? null)
    : requiredContrast(pairing.classification);
  const ruleId = (() => {
    if (measurement.status === 'needs-review') return 'wcag-needs-review';
    if (pairing.id.startsWith('polarity-ink')) return 'cinder-polarity-ink';
    if (advisoryScope) return 'cinder-decorative-border-floor';
    if (pairing.classification === 'disabled') return 'wcag-inactive-component';
    if (pairing.classification === 'non-text-indicator') return 'wcag-1.4.11-non-text-contrast';
    if (pairing.classification === 'large-text') return 'wcag-1.4.3-large-text-contrast';
    return 'wcag-1.4.3-text-contrast';
  })();
  const rule = ruleById(ruleId);
  const properties =
    measurement.status === 'measured'
      ? measurement.stack.map((layer) => layer.property)
      : [pairing.foreground, pairing.background, ...(pairing.backdrop ? [pairing.backdrop] : [])];
  const stack: StackEntry[] =
    measurement.status === 'measured'
      ? measurement.stack.map((layer) => ({
          role: layer.role,
          cssProperty: layer.property,
          tokenPath: tokenPathForProperty(layer.property),
          value: layer.value,
          rgb: layer.rgb,
        }))
      : [];
  const untested = [
    ...(scenes.length === 0
      ? ['No reference scene renders this pairing; it is checked from tokens only.']
      : []),
    ...(pairing.classification === 'text'
      ? ['Rendered text size is not recorded, so the 4.5:1 text threshold applies.']
      : []),
  ];
  const exceptions = [
    ...(rule.exception !== null && pairing.classification !== 'text' ? [rule.exception] : []),
    ...(measurement.status === 'measured' && measurement.clamped
      ? ['A color is outside sRGB and was clamped to be measured.']
      : []),
  ];
  const base = {
    outcomeSet: advisoryScope ? ('advisory' as const) : ('wcag' as const),
    pairingId: pairing.id,
    classification: pairing.classification,
    tokenPaths: properties.flatMap((property) => tokenPathForProperty(property) ?? []),
    cssProperties: properties,
    stack,
    scenes,
    context: context.context,
    sourceRevision: context.sourceRevision,
    exceptions,
    untested,
    actions: [] as const,
    ruleId,
    id: `${ruleId}:${pairing.id}:${context.context}`,
    required,
    unit: 'ratio' as const,
  };
  if (measurement.status === 'needs-review') {
    return {
      ...base,
      id: `${ruleId}:${pairing.id}:${context.context}`,
      outcome: 'needs-review',
      severity: advisoryScope ? 'advisory' : 'needs-review',
      message: `${pairing.description} could not be measured: ${measurement.reason}`,
      measured: null,
    };
  }
  if (!advisoryScope && required === null) {
    return {
      ...base,
      outcome: 'exempt',
      severity: null,
      message: `${pairing.description} measures ${measurement.ratio.toFixed(2)}:1; WCAG sets no minimum for an inactive component.`,
      measured: measurement.ratio,
    };
  }
  const passes = required === null || measurement.ratio >= required;
  const severity: Severity | null = passes
    ? null
    : advisoryScope
      ? 'advisory'
      : 'accessibility-error';
  return {
    ...base,
    outcome: passes ? 'pass' : 'fail',
    severity,
    message: `${pairing.description} measures ${measurement.ratio.toFixed(3)}:1; ${required}:1 is required.`,
    measured: measurement.ratio,
  };
}

function profileRecords(
  properties: Record<string, string>,
  context: RecordContext,
): ReportRecord[] {
  const records: ReportRecord[] = [];
  for (const [property, value] of Object.entries(properties)) {
    const profile = profileByProperty.get(property);
    const range = profile?.range;
    if (profile === undefined || range === undefined) continue;
    const match = /^(-?\d*\.?\d+)(px|rem|ms|s)?$/.exec(value.trim());
    if (match === null) continue;
    const reason = profileRangeViolation(profile, Number(match[1]));
    if (reason === undefined) continue;
    const rule = ruleById('cinder-profile-range');
    records.push({
      id: `cinder-profile-range:${property}:${context.context}`,
      ruleId: rule.id,
      outcomeSet: 'cinder-profile',
      outcome: 'fail',
      severity: 'advisory',
      message: `${property} is ${value}, which ${reason} for the ${profile.id} profile.`,
      measured: Number(match[1]),
      required: null,
      unit: 'none',
      tokenPaths: tokenPathForProperty(property) ?? [],
      cssProperties: [property],
      pairingId: null,
      classification: null,
      stack: [],
      scenes: [],
      context: context.context,
      sourceRevision: context.sourceRevision,
      exceptions: rule.exception === null ? [] : [rule.exception],
      untested: [],
      actions: [],
    });
  }
  return records;
}

export function buildAccessibilityReport(input: ReportInput): AccessibilityReport {
  const { outcome, evaluated } = sourceValidity(input.evaluations);
  const report: AccessibilityReport = {
    stamp: {
      themeId: input.themeId,
      sourceRevision: input.sourceRevision,
      contexts: THEME_CONTEXT_IDS,
    },
    sourceValidity: outcome,
    records: { cinderProfile: [], wcag: [], advisory: [] },
    untested: UNTESTED_ALWAYS,
  };
  // An invalid revision produces no contrast results: nothing was evaluated to measure.
  if (outcome.status === 'invalid') return report;

  for (const [contextId, properties] of evaluated) {
    const context: RecordContext = {
      context: contextId,
      sourceRevision: input.sourceRevision,
      properties,
      theme: contextId.startsWith('dark') ? 'dark' : 'light',
      tokenPathFor: tokenPathForProperty,
    };
    for (const pairing of CONTRAST_PAIRINGS) {
      const measurement = measurePairing(pairing, properties, { theme: context.theme });
      const record = recordForPairing(pairing, measurement, context);
      (record.outcomeSet === 'wcag' ? report.records.wcag : report.records.advisory).push(record);
      report.records.advisory.push(
        ...pairingAdvisories(pairing, measurement, context, record.scenes),
      );
    }
    report.records.advisory.push(
      ...borderHierarchyRecords(context),
      ...chartDistinguishabilityRecords(context),
    );
    report.records.cinderProfile.push(...profileRecords(properties, context));
  }
  return report;
}

/** Every record of every outcome set, in set order. */
export function allRecords(report: AccessibilityReport): ReportRecord[] {
  return [...report.records.cinderProfile, ...report.records.wcag, ...report.records.advisory];
}

/** The records that need a person's attention: everything with a severity. */
export function reportFindings(report: AccessibilityReport): ReportRecord[] {
  return allRecords(report).filter((record) => record.severity !== null);
}

export function countReport(report: AccessibilityReport): ReportCounts {
  const counts: ReportCounts = {
    'invalid-source': 0,
    'accessibility-error': 0,
    'needs-review': 0,
    advisory: 0,
    pass: 0,
    exempt: 0,
  };
  if (report.sourceValidity.status === 'invalid') {
    counts['invalid-source'] = report.sourceValidity.diagnostics.length;
  }
  for (const record of allRecords(report)) {
    if (record.severity !== null) counts[record.severity] += 1;
    else if (record.outcome === 'pass') counts.pass += 1;
    else if (record.outcome === 'exempt') counts.exempt += 1;
  }
  return counts;
}

/** True only while the report still describes the draft: same theme, same committed revision. */
export function isReportCurrent(
  report: AccessibilityReport | null,
  themeId: string | null,
  sourceRevision: number | null,
): boolean {
  return (
    report !== null &&
    report.stamp.themeId === themeId &&
    report.stamp.sourceRevision === sourceRevision
  );
}

/** Findings that block or hold a passing report: not advisories. */
export function outstandingCount(counts: ReportCounts): number {
  return counts['invalid-source'] + counts['accessibility-error'] + counts['needs-review'];
}

/**
 * Export readiness. Accessibility errors block the normal export, Needs review blocks a
 * passing report, advisories never change it, and a stale or missing report is never ready.
 */
export function exportReadiness(
  report: AccessibilityReport | null,
  current: boolean,
  running: boolean,
): ExportReadiness {
  if (report === null) return 'checking';
  if (!current) return running ? 'checking' : 'stale';
  const counts = countReport(report);
  if (counts['invalid-source'] > 0) return 'blocked-invalid-source';
  if (counts['accessibility-error'] > 0) return 'blocked-accessibility-errors';
  if (counts['needs-review'] > 0) return 'needs-review';
  return 'ready';
}
