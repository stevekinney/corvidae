/**
 * The advisory outcome set (COR-259): Cinder's stricter guardrails, APCA, and gamut. These
 * records are always visible and are never able to change pass or fail. They are computed
 * from the same context property map and the same measurement as the WCAG set, but they are
 * returned separately so one set cannot overwrite another.
 */

import {
  BORDER_TIER_MAX_SPREAD,
  CHART_MIN_CHROMA,
  CHART_MIN_DELTA_E,
  CHART_MIN_DELTA_L,
  CHART_SERIES_COUNT,
  SURFACE_PROPERTIES,
  ciede2000,
  evaluateCssColor,
  measurePairing,
  toCieLab,
  type ContrastPairing,
  type PairingMeasurement,
  type StackLayer,
} from '@lostgradient/cinder/tokens/runtime';

import { ruleById } from './theme-check-rules.ts';
import type { ReportRecord, SceneReference } from './theme-check-types.ts';
import type { ThemeContextId } from './theme-draft-types.ts';

export type RecordContext = {
  context: ThemeContextId;
  sourceRevision: number;
  properties: Readonly<Record<string, string>>;
  theme: 'light' | 'dark';
  tokenPathFor: (cssProperty: string) => string | null;
};

const APCA_BODY_LC = 60;

/** APCA-W3 0.0.98G lightness contrast for gamma-encoded sRGB text over an opaque background. */
export function apcaLc(
  text: { r: number; g: number; b: number },
  background: { r: number; g: number; b: number },
): number {
  const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
    const y = 0.2126729 * r ** 2.4 + 0.7151522 * g ** 2.4 + 0.072175 * b ** 2.4;
    return y < 0.022 ? y + (0.022 - y) ** 1.414 : y;
  };
  const textY = luminance(text);
  const backgroundY = luminance(background);
  if (Math.abs(backgroundY - textY) < 0.0005) return 0;
  if (backgroundY > textY) {
    const contrast = (backgroundY ** 0.56 - textY ** 0.57) * 1.14;
    return (contrast < 0.1 ? 0 : contrast - 0.027) * 100;
  }
  const contrast = (backgroundY ** 0.65 - textY ** 0.62) * 1.14;
  return (contrast > -0.1 ? 0 : contrast + 0.027) * 100;
}

const stackEntries = (stack: StackLayer[], context: RecordContext) =>
  stack.map((layer) => ({
    role: layer.role,
    cssProperty: layer.property,
    tokenPath: context.tokenPathFor(layer.property),
    value: layer.value,
    rgb: layer.rgb,
  }));

type Base = Pick<RecordContext, 'context' | 'sourceRevision'>;

function advisoryRecord(
  base: Base,
  ruleId: string,
  subject: string,
  fields: Partial<ReportRecord> & Pick<ReportRecord, 'outcome' | 'message'>,
): ReportRecord {
  return {
    id: `${ruleId}:${subject}:${base.context}`,
    ruleId,
    outcomeSet: 'advisory',
    severity: fields.outcome === 'pass' ? null : 'advisory',
    measured: null,
    required: null,
    unit: 'none',
    tokenPaths: [],
    cssProperties: [],
    pairingId: null,
    classification: null,
    stack: [],
    scenes: [],
    context: base.context,
    sourceRevision: base.sourceRevision,
    exceptions: ruleById(ruleId).exception === null ? [] : [ruleById(ruleId).exception!],
    untested: [],
    actions: [],
    ...fields,
  };
}

/** APCA and gamut records for one measured pairing. */
export function pairingAdvisories(
  pairing: ContrastPairing,
  measurement: PairingMeasurement,
  context: RecordContext,
  scenes: SceneReference[],
): ReportRecord[] {
  if (measurement.status !== 'measured') return [];
  const records: ReportRecord[] = [];
  const shared = {
    pairingId: pairing.id,
    classification: pairing.classification,
    stack: stackEntries(measurement.stack, context),
    scenes,
    cssProperties: measurement.stack.map((layer) => layer.property),
    tokenPaths: measurement.stack.flatMap((layer) => context.tokenPathFor(layer.property) ?? []),
  };
  if (pairing.classification === 'text' && pairing.scope === 'wcag') {
    const lc = Math.abs(apcaLc(measurement.ink, measurement.ground));
    records.push(
      advisoryRecord(context, 'apca-lightness-contrast', pairing.id, {
        ...shared,
        outcome: lc >= APCA_BODY_LC ? 'pass' : 'fail',
        message: `APCA Lc ${lc.toFixed(1)} for ${pairing.description}; advisory floor ${APCA_BODY_LC}.`,
        measured: lc,
        required: APCA_BODY_LC,
        unit: 'lc',
      }),
    );
  }
  if (measurement.clamped) {
    records.push(
      advisoryRecord(context, 'gamut-clamped', pairing.id, {
        ...shared,
        outcome: 'fail',
        message: `${pairing.description} uses a color outside sRGB; it was clamped to be measured.`,
      }),
    );
  }
  return records;
}

const TIERS = ['--cinder-border-muted', '--cinder-border', '--cinder-border-strong'] as const;
const SURFACES = SURFACE_PROPERTIES;

/** Border tiers: consistent weight across surfaces, and strong > control > muted. */
export function borderHierarchyRecords(context: RecordContext): ReportRecord[] {
  const ratio = (tier: string, surface: string): number | null => {
    const probe: ContrastPairing = {
      id: `probe:${tier}:${surface}`,
      group: 'control-border',
      classification: 'decorative-separator',
      scope: 'cinder-advisory',
      criterion: null,
      foreground: tier,
      background: surface,
      description: 'probe',
    };
    const measurement = measurePairing(probe, context.properties, { theme: context.theme });
    return measurement.status === 'measured' ? measurement.ratio : null;
  };
  const records: ReportRecord[] = [];
  const paths = (...properties: string[]) =>
    properties.flatMap((p) => context.tokenPathFor(p) ?? []);
  const grid = TIERS.map((tier) => SURFACES.map((surface) => ratio(tier, surface)));
  if (grid.flat().some((value) => value === null)) {
    return [
      advisoryRecord(context, 'cinder-border-hierarchy', 'tiers', {
        outcome: 'needs-review',
        message: 'A border tier could not be measured on every surface.',
        cssProperties: [...TIERS, ...SURFACES],
        tokenPaths: paths(...TIERS, ...SURFACES),
      }),
    ];
  }
  TIERS.forEach((tier, tierIndex) => {
    const values = grid[tierIndex]!.map(Number);
    const spread = (Math.max(...values) - Math.min(...values)) / Math.max(...values);
    records.push(
      advisoryRecord(context, 'cinder-border-hierarchy', `spread:${tier}`, {
        outcome: spread <= BORDER_TIER_MAX_SPREAD ? 'pass' : 'fail',
        message: `${tier} varies ${(spread * 100).toFixed(1)}% across surfaces; the guardrail allows ${BORDER_TIER_MAX_SPREAD * 100}%.`,
        measured: spread,
        required: BORDER_TIER_MAX_SPREAD,
        unit: 'spread',
        cssProperties: [tier, ...SURFACES],
        tokenPaths: paths(tier, ...SURFACES),
      }),
    );
  });
  SURFACES.forEach((surface, surfaceIndex) => {
    const [muted, control, strong] = grid.map((row) => Number(row[surfaceIndex]));
    records.push(
      advisoryRecord(context, 'cinder-border-hierarchy', `order:${surface}`, {
        outcome: strong! > control! && control! > muted! ? 'pass' : 'fail',
        message: `Border tiers on ${surface} read ${muted!.toFixed(2)}, ${control!.toFixed(2)}, ${strong!.toFixed(2)} (muted, control, strong).`,
        cssProperties: [...TIERS, surface],
        tokenPaths: paths(...TIERS, surface),
      }),
    );
  });
  return records;
}

/** Chart series: chroma, pairwise CIEDE2000 and CIE L* separation. */
export function chartDistinguishabilityRecords(context: RecordContext): ReportRecord[] {
  const properties = Array.from(
    { length: CHART_SERIES_COUNT },
    (_, index) => `--cinder-chart-series-${index + 1}`,
  );
  const colors = properties.map((property) => {
    const value = context.properties[property];
    return value === undefined
      ? null
      : evaluateCssColor(value, context.properties, { theme: context.theme });
  });
  const scenes: SceneReference[] = [
    { sceneId: 'charts/line-chart-multi-series', state: 'default', background: 'surface' },
  ];
  const base = {
    cssProperties: properties,
    tokenPaths: properties.flatMap((p) => context.tokenPathFor(p) ?? []),
    scenes,
  };
  if (colors.some((color) => color === null || !color.ok)) {
    return [
      advisoryRecord(context, 'cinder-chart-distinguishability', 'series', {
        ...base,
        outcome: 'needs-review',
        message: 'A chart series color could not be evaluated.',
      }),
    ];
  }
  const oklch = colors.map(
    (color) => (color as { ok: true; color: { l: number; c: number; h?: number } }).color,
  );
  const labs = oklch.map(({ l, c, h }) => toCieLab({ l, c, h: h ?? 0 }));
  let minDeltaE = Infinity;
  let minDeltaL = Infinity;
  for (let a = 0; a < labs.length; a += 1) {
    for (let b = a + 1; b < labs.length; b += 1) {
      minDeltaE = Math.min(minDeltaE, ciede2000(labs[a]!, labs[b]!));
      minDeltaL = Math.min(minDeltaL, Math.abs(labs[a]![0] - labs[b]![0]));
    }
  }
  const minChroma = Math.min(...oklch.map((color) => color.c));
  const checks: Array<[string, number, number, ReportRecord['unit'], string]> = [
    ['chroma', minChroma, CHART_MIN_CHROMA, 'chroma', 'Lowest series chroma'],
    ['delta-e', minDeltaE, CHART_MIN_DELTA_E, 'delta-e', 'Closest pair CIEDE2000'],
    ['delta-l', minDeltaL, CHART_MIN_DELTA_L, 'delta-e', 'Closest pair CIE L* separation'],
  ];
  return checks.map(([subject, measured, required, unit, label]) =>
    advisoryRecord(context, 'cinder-chart-distinguishability', subject, {
      ...base,
      outcome: measured >= required ? 'pass' : 'fail',
      message: `${label} is ${measured.toFixed(3)}; the guardrail asks for ${required}.`,
      measured,
      required,
      unit,
      untested: ['Color-vision-deficiency separation is a diagnostic here, not a proof.'],
    }),
  );
}
