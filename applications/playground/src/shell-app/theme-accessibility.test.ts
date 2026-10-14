import { describe, expect, it } from 'bun:test';

import type { ContrastPairing } from '@lostgradient/cinder/tokens/runtime';
import { CONTRAST_PAIRINGS, measurePairing } from '@lostgradient/cinder/tokens/runtime';

import { cinderThemeBase } from './theme-builder-base.ts';
import {
  allRecords,
  buildAccessibilityReport,
  countReport,
  exportReadiness,
  isReportCurrent,
  outstandingCount,
  recordForPairing,
  reportFindings,
} from './theme-check-engine.ts';
import { CHECK_RULES, ruleById } from './theme-check-rules.ts';
import type { AccessibilityReport } from './theme-check-types.ts';
import type { ThemeEvaluation } from './theme-draft-evaluation.ts';
import { THEME_CONTEXT_IDS, type ThemeContextId, type ThemeEnvelope } from './theme-draft-types.ts';
import { createEnvelope } from './theme-envelope.ts';
import { setNode } from './theme-override-tree.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';

const evaluator = createRuntimeEvaluator();

async function evaluateAll(
  envelope: ThemeEnvelope,
  revision: number,
): Promise<Partial<Record<ThemeContextId, ThemeEvaluation>>> {
  const evaluations: Partial<Record<ThemeContextId, ThemeEvaluation>> = {};
  for (const context of THEME_CONTEXT_IDS) {
    evaluations[context] = await evaluator.evaluate(envelope, revision, context);
  }
  return evaluations;
}

// The runtime evaluation is work, so it happens once at module scope, outside the test budget.
const shipped = createEnvelope('shipped', 'Cinder default', cinderThemeBase());
const shippedEvaluations = await evaluateAll(shipped, 1);
const shippedReport = buildAccessibilityReport({
  themeId: 'shipped',
  sourceRevision: 1,
  evaluations: shippedEvaluations,
});

const dimmedText: ThemeEnvelope = {
  ...shipped,
  overrides: {
    ...shipped.overrides,
    light: setNode(shipped.overrides.light, 'text.default', {
      $type: 'color',
      $value: { colorSpace: 'oklch', components: [0.93, 0.01, 245] },
    }),
  },
};
const dimmedReport = buildAccessibilityReport({
  themeId: 'shipped',
  sourceRevision: 2,
  evaluations: await evaluateAll(dimmedText, 2),
});

const grayProperties = (foreground: number, background: number) => ({
  '--fg': `oklch(${foreground} 0 0)`,
  '--bg': `oklch(${background} 0 0)`,
});
const probe = (overrides: Partial<ContrastPairing> = {}): ContrastPairing => ({
  id: 'probe',
  group: 'text',
  classification: 'text',
  scope: 'wcag',
  criterion: '1.4.3',
  foreground: '--fg',
  background: '--bg',
  description: 'Probe text',
  ...overrides,
});
const context = {
  context: 'light/default' as const,
  sourceRevision: 1,
  properties: {},
  theme: 'light' as const,
  tokenPathFor: () => null,
};
const recordFor = (pairing: ContrastPairing, properties: Record<string, string>) =>
  recordForPairing(pairing, measurePairing(pairing, properties, { theme: 'light' }), context);

describe('the default Cinder theme', () => {
  it('evaluates all six contexts before it produces a report', () => {
    expect(shippedReport.stamp.contexts).toEqual(THEME_CONTEXT_IDS);
    expect(shippedReport.sourceValidity.status).toBe('valid');
    const seen = new Set(shippedReport.records.wcag.map((record) => record.context));
    expect([...seen].sort()).toEqual([...THEME_CONTEXT_IDS].sort());
  });

  it('reports zero accessibility errors and zero invalid-source findings', () => {
    const errors = reportFindings(shippedReport).filter(
      (finding) => finding.severity === 'accessibility-error',
    );
    expect(errors.map((finding) => finding.id)).toEqual([]);
    const counts = countReport(shippedReport);
    expect(counts['invalid-source']).toBe(0);
    expect(counts.pass).toBeGreaterThan(CONTRAST_PAIRINGS.length);
    expect(counts.exempt).toBeGreaterThan(0);
  });

  it('measures every shipped pairing in every context, with no Needs review', () => {
    expect(countReport(shippedReport)['needs-review']).toBe(0);
    const perContext = shippedReport.records.wcag.length + shippedReport.records.advisory.length;
    expect(perContext).toBeGreaterThanOrEqual(CONTRAST_PAIRINGS.length * THEME_CONTEXT_IDS.length);
  });

  it('is ready for export, and says only what it checked', () => {
    expect(exportReadiness(shippedReport, true, false)).toBe('ready');
    expect(shippedReport.untested.length).toBeGreaterThan(0);
  });
});

describe('report records', () => {
  it('carry every field COR-487 keys on, with a stable unique id', () => {
    const records = allRecords(shippedReport);
    expect(new Set(records.map((record) => record.id)).size).toBe(records.length);
    for (const record of records) {
      expect(CHECK_RULES.some((rule) => rule.id === record.ruleId)).toBe(true);
      expect(record.context).toBeDefined();
      expect(record.sourceRevision).toBe(1);
      expect(record.actions).toEqual([]);
      expect(Array.isArray(record.exceptions)).toBe(true);
      expect(Array.isArray(record.untested)).toBe(true);
    }
    const sample = shippedReport.records.wcag.find((record) => record.pairingId !== null)!;
    expect(sample.tokenPaths.length).toBeGreaterThan(0);
    expect(sample.stack.map((entry) => entry.role)).toContain('foreground');
    expect(sample.measured).not.toBeNull();
    expect(sample.required).not.toBeNull();
  });

  it('is deterministic for the same input', async () => {
    const again = buildAccessibilityReport({
      themeId: 'shipped',
      sourceRevision: 1,
      evaluations: shippedEvaluations,
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(shippedReport));
  });

  it('keeps the four outcome sets apart', () => {
    expect(shippedReport.records.wcag.every((record) => record.outcomeSet === 'wcag')).toBe(true);
    expect(shippedReport.records.advisory.every((record) => record.outcomeSet === 'advisory')).toBe(
      true,
    );
    expect(
      shippedReport.records.cinderProfile.every((record) => record.outcomeSet === 'cinder-profile'),
    ).toBe(true);
    expect(shippedReport.sourceValidity).toEqual({ status: 'valid' });
  });
});

describe('an edit that breaks contrast', () => {
  it('reports accessibility errors scoped to the contexts and tokens it affects', () => {
    const errors = reportFindings(dimmedReport).filter(
      (finding) => finding.severity === 'accessibility-error',
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((finding) => finding.context.startsWith('light/'))).toBe(true);
    const sample = errors.find((finding) => finding.pairingId === 'text:default:surface')!;
    expect(sample.measured!).toBeLessThan(sample.required!);
    expect(sample.required).toBe(4.5);
    expect(sample.tokenPaths).toContain('text.default');
    expect(sample.sourceRevision).toBe(2);
    expect(sample.scenes.length).toBeGreaterThan(0);
    expect(sample.ruleId).toBe('wcag-1.4.3-text-contrast');
    expect(exportReadiness(dimmedReport, true, false)).toBe('blocked-accessibility-errors');
    expect(outstandingCount(countReport(dimmedReport))).toBeGreaterThan(0);
  });
});

describe('thresholds are unrounded', () => {
  // Bisect the lightness of mid-gray text on a white background to the exact 4.5:1 crossing.
  const crossing = (() => {
    let low = 0.3;
    let high = 0.8;
    for (let step = 0; step < 60; step += 1) {
      const mid = (low + high) / 2;
      const measurement = measurePairing(probe(), grayProperties(mid, 1), { theme: 'light' });
      if (measurement.status === 'measured' && measurement.ratio >= 4.5) low = mid;
      else high = mid;
    }
    return { passes: low, fails: high };
  })();

  it('fails text one hair under 4.5:1 and passes it at 4.5:1', () => {
    const passing = recordFor(probe(), grayProperties(crossing.passes, 1));
    const failing = recordFor(probe(), grayProperties(crossing.fails, 1));
    expect(passing.outcome).toBe('pass');
    expect(passing.measured!).toBeGreaterThanOrEqual(4.5);
    expect(failing.outcome).toBe('fail');
    expect(failing.severity).toBe('accessibility-error');
    expect(failing.measured!).toBeLessThan(4.5);
    expect(failing.measured!).toBeGreaterThan(4.499);
  });

  it('holds non-text indicators to 3:1 and fails a hair under it', () => {
    let low = 0.5;
    let high = 0.95;
    for (let step = 0; step < 60; step += 1) {
      const mid = (low + high) / 2;
      const measurement = measurePairing(probe(), grayProperties(mid, 1), { theme: 'light' });
      if (measurement.status === 'measured' && measurement.ratio >= 3) low = mid;
      else high = mid;
    }
    const indicator = probe({ classification: 'non-text-indicator', criterion: '1.4.11' });
    expect(recordFor(indicator, grayProperties(low, 1)).outcome).toBe('pass');
    const failing = recordFor(indicator, grayProperties(high, 1));
    expect(failing.outcome).toBe('fail');
    expect(failing.measured!).toBeGreaterThan(2.999);
    expect(failing.ruleId).toBe('wcag-1.4.11-non-text-contrast');
  });

  it('applies 3:1 to large text only, and 4.5:1 to the same colors as body text', () => {
    const properties = grayProperties(0.62, 1);
    expect(recordFor(probe(), properties).outcome).toBe('fail');
    const large = recordFor(probe({ classification: 'large-text' }), properties);
    expect(large.outcome).toBe('pass');
    expect(large.required).toBe(3);
  });

  it('stacks a translucent foreground over its background before comparing', () => {
    const solid = recordFor(probe(), { '--fg': 'oklch(0.2 0 0)', '--bg': '#fff' });
    const faded = recordFor(probe(), { '--fg': 'oklch(0.2 0 0 / 0.4)', '--bg': '#fff' });
    expect(solid.outcome).toBe('pass');
    expect(faded.measured!).toBeLessThan(solid.measured!);
    expect(faded.outcome).toBe('fail');
  });
});

describe('what cannot be measured is never a pass', () => {
  const withSurface = (value: string) => {
    const list = Object.entries(shippedEvaluationProperties('light/default')).map(([name, v]) => ({
      name,
      value: name === '--cinder-surface' ? value : v,
    }));
    return {
      ...shippedEvaluations,
      'light/default': { ...shippedEvaluations['light/default']!, properties: list },
    } as typeof shippedEvaluations;
  };

  it('reports a gradient surface as Needs review and blocks a passing report', () => {
    const report = buildAccessibilityReport({
      themeId: 'shipped',
      sourceRevision: 1,
      evaluations: withSurface('linear-gradient(white, black)'),
    });
    const review = reportFindings(report).filter((finding) => finding.severity === 'needs-review');
    expect(review.length).toBeGreaterThan(0);
    expect(review.every((finding) => finding.measured === null)).toBe(true);
    expect(review.every((finding) => finding.outcome === 'needs-review')).toBe(true);
    expect(exportReadiness(report, true, false)).toBe('needs-review');
  });

  it('reports a translucent surface with no known backdrop as Needs review', () => {
    const record = recordFor(probe(), { '--fg': '#000', '--bg': 'oklch(1 0 0 / 0.5)' });
    expect(record.outcome).toBe('needs-review');
    expect(record.severity).toBe('needs-review');
    expect(record.ruleId).toBe('wcag-needs-review');
  });

  it('reports an unsupported color syntax and a missing value as Needs review', () => {
    expect(
      recordFor(probe(), { '--fg': 'color-mix(in srgb, red, blue)', '--bg': '#fff' }).outcome,
    ).toBe('needs-review');
    expect(recordFor(probe(), { '--bg': '#fff' }).outcome).toBe('needs-review');
  });
});

function shippedEvaluationProperties(context: ThemeContextId): Record<string, string> {
  const evaluation = shippedEvaluations[context]!;
  if (!evaluation.ok) throw new Error('shipped theme must evaluate');
  return Object.fromEntries(evaluation.properties.map(({ name, value }) => [name, value]));
}

describe('classified exceptions are explicit, not waived', () => {
  it('records disabled foregrounds as exempt with the measured ratio and the exception', () => {
    const disabled = shippedReport.records.wcag.filter(
      (record) => record.classification === 'disabled',
    );
    expect(disabled.length).toBeGreaterThan(0);
    for (const record of disabled) {
      expect(record.outcome).toBe('exempt');
      expect(record.measured).not.toBeNull();
      expect(record.required).toBeNull();
      expect(record.exceptions.join(' ')).toContain('inactive');
    }
  });

  it('keeps decorative separators out of the WCAG set, under Cinder floors', () => {
    const decorative = shippedReport.records.advisory.filter(
      (record) => record.classification === 'decorative-separator',
    );
    expect(decorative.length).toBeGreaterThan(0);
    expect(
      shippedReport.records.wcag.some((record) => record.classification === 'decorative-separator'),
    ).toBe(false);
  });

  it('lets an advisory failure show without changing the export status', () => {
    const faint = recordFor(
      probe({
        scope: 'cinder-advisory',
        classification: 'decorative-separator',
        criterion: null,
        advisoryFloor: 1.4,
      }),
      grayProperties(0.97, 1),
    );
    expect(faint.outcomeSet).toBe('advisory');
    expect(faint.severity).toBe('advisory');
    const withAdvisory: AccessibilityReport = {
      ...shippedReport,
      records: { ...shippedReport.records, advisory: [...shippedReport.records.advisory, faint] },
    };
    expect(exportReadiness(withAdvisory, true, false)).toBe('ready');
  });

  it('has a ledger entry for every rule an emitted record cites', () => {
    for (const record of [...allRecords(shippedReport), ...allRecords(dimmedReport)]) {
      expect(() => ruleById(record.ruleId)).not.toThrow();
    }
    const manual = CHECK_RULES.filter((rule) => rule.method !== 'static');
    for (const criterion of [
      '1.4.4',
      '1.4.10',
      '1.4.12',
      '2.4.7',
      '2.4.11',
      '2.5.8',
      '3.3.1',
      '4.1.2',
    ]) {
      expect(manual.some((rule) => rule.criterion?.includes(criterion))).toBe(true);
    }
  });
});

describe('a report is only ever as fresh as its revision', () => {
  it('is current for its own revision and stale after any edit, so it cannot show Pass', () => {
    expect(isReportCurrent(shippedReport, 'shipped', 1)).toBe(true);
    expect(isReportCurrent(shippedReport, 'shipped', 2)).toBe(false);
    expect(isReportCurrent(shippedReport, 'other', 1)).toBe(false);
    expect(isReportCurrent(null, 'shipped', 1)).toBe(false);
    expect(exportReadiness(shippedReport, false, false)).toBe('stale');
    expect(exportReadiness(shippedReport, false, true)).toBe('checking');
    expect(exportReadiness(null, false, true)).toBe('checking');
  });
});

describe('an invalid revision', () => {
  it('reports invalid source and produces no contrast results', async () => {
    const broken: ThemeEvaluation = {
      revision: 3,
      context: 'light/default',
      ok: false,
      diagnostics: [{ path: 'text.default', code: 'invalid-theme', message: 'Bad value.' }],
    };
    const report = buildAccessibilityReport({
      themeId: 'shipped',
      sourceRevision: 3,
      evaluations: { ...shippedEvaluations, 'light/default': broken },
    });
    expect(report.sourceValidity.status).toBe('invalid');
    expect(allRecords(report)).toEqual([]);
    expect(countReport(report)['invalid-source']).toBe(1);
    expect(exportReadiness(report, true, false)).toBe('blocked-invalid-source');
  });

  it('does not treat a missing context as checked', () => {
    const { 'dark/reduced': _omitted, ...partial } = shippedEvaluations;
    const report = buildAccessibilityReport({
      themeId: 'shipped',
      sourceRevision: 1,
      evaluations: partial,
    });
    expect(report.sourceValidity.status).toBe('invalid');
    expect(exportReadiness(report, true, false)).not.toBe('ready');
  });
});
