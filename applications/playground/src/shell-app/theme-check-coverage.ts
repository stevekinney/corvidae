/**
 * The token-to-rule coverage ledger (COR-259): every public registry token is classified as
 * statically checked, scene-checked, advisory or not automatically checkable, with a reason.
 * The ledger derives from the authoring catalogue, so a token added to the registry is
 * classified here or the coverage test fails; no count is written down anywhere.
 *
 * Coverage says which check looks at a token. It does not say every component combination
 * using the token has been proved.
 */

import {
  AUTHORING_CATALOGUE,
  CONTRAST_PAIRINGS,
  type AuthoringRecord,
} from '@lostgradient/cinder/tokens/runtime';

export const COVERAGE_CLASSES = [
  'statically-checked',
  'scene-checked',
  'advisory',
  'not-automatically-checkable',
] as const;
export type CoverageClass = (typeof COVERAGE_CLASSES)[number];

export type TokenCoverage = {
  path: string;
  cssProperty: string;
  profile: string;
  coverage: CoverageClass;
  reason: string;
  /** Rule ids or pairing ids that look at the token, when it has any. */
  checkedBy: string[];
};

type Reference = { pairingId: string; scope: 'wcag' | 'cinder-advisory' };

const referencesByProperty = new Map<string, Reference[]>();
for (const pairing of CONTRAST_PAIRINGS) {
  for (const property of [
    pairing.foreground,
    pairing.background,
    pairing.backdrop,
    pairing.opacity,
  ]) {
    if (property === undefined) continue;
    const list = referencesByProperty.get(property) ?? [];
    list.push({ pairingId: pairing.id, scope: pairing.scope });
    referencesByProperty.set(property, list);
  }
}
/** Tokens the border-hierarchy and chart rules read beyond the pairing table. */
const ADVISORY_RULE_PROPERTIES = new Map<string, string>([
  ['--cinder-border-ink', 'cinder-border-hierarchy'],
]);

type ProfileRule = { coverage: CoverageClass; reason: string; checkedBy: string[] };

const RENDERED_SIZE: ProfileRule = {
  coverage: 'scene-checked',
  reason:
    'Affects text size, spacing or target size; the rendered checks (200% resize, 320px reflow, text spacing, 24px targets) run on the reference scenes.',
  checkedBy: ['rendered-1.4.4-resize-text', 'rendered-1.4.10-reflow', 'rendered-2.5.8-target-size'],
};
const NOT_CHECKABLE = (reason: string): ProfileRule => ({
  coverage: 'not-automatically-checkable',
  reason,
  checkedBy: [],
});

const NON_COLOR_PROFILES: Record<string, ProfileRule> = {
  spacing: RENDERED_SIZE,
  padding: RENDERED_SIZE,
  gap: RENDERED_SIZE,
  margin: RENDERED_SIZE,
  height: RENDERED_SIZE,
  size: RENDERED_SIZE,
  width: RENDERED_SIZE,
  'font-size': RENDERED_SIZE,
  'line-height': RENDERED_SIZE,
  'letter-spacing': RENDERED_SIZE,
  'font-weight': {
    ...RENDERED_SIZE,
    reason:
      'Weight can move text into or out of the large-text definition; no pairing records a size, so text is held to 4.5:1, and the rendered text-spacing check covers the layout.',
    checkedBy: ['wcag-1.4.3-text-contrast', 'rendered-1.4.12-text-spacing'],
  },
  duration: {
    coverage: 'scene-checked',
    reason: 'Motion timing is exercised by the reduced-motion rendered check.',
    checkedBy: ['rendered-reduced-motion'],
  },
  easing: {
    coverage: 'scene-checked',
    reason: 'Motion curves are exercised by the reduced-motion rendered check.',
    checkedBy: ['rendered-reduced-motion'],
  },
  opacity: NOT_CHECKABLE(
    'An opacity changes contrast only where a component applies it to text; the disabled opacity is paired separately, the others have no known pairing.',
  ),
  radius: NOT_CHECKABLE('Corner radius has no accessibility threshold of its own.'),
  shadow: NOT_CHECKABLE(
    'A shadow is not relied on for a boundary; whether it separates a surface is a design judgment.',
  ),
  blur: NOT_CHECKABLE('Blur radius has no accessibility threshold of its own.'),
  offset: NOT_CHECKABLE('Offsets have no accessibility threshold of their own.'),
  'z-index': NOT_CHECKABLE(
    'Stacking order is checked by the focus-not-obscured rendered check, not per token.',
  ),
  'aspect-ratio': NOT_CHECKABLE('An aspect ratio has no accessibility threshold of its own.'),
  'tab-size': NOT_CHECKABLE('Tab size has no accessibility threshold of its own.'),
  'font-family': NOT_CHECKABLE(
    'Font availability and glyph metrics depend on the environment; the specimen shows the stack.',
  ),
  'border-width': NOT_CHECKABLE(
    'Border width alone does not set contrast; the border color is paired, and thickness is judged in the scene.',
  ),
};

/** Tokens whose absence from the contrast table is a decision, with the reason it was taken. */
const DELIBERATE_EXCLUSIONS = new Map<string, string>([
  [
    '--cinder-accent-solid-active',
    'Not paired with the accent label on purpose: it falls below 4.5:1 against that label in the dark contexts, and the buttons paint the pressed fill with accent.solid.active.on-fill instead.',
  ],
]);

function colorRule(record: AuthoringRecord): ProfileRule {
  const exclusion = DELIBERATE_EXCLUSIONS.get(record.cssProperty);
  if (exclusion !== undefined) return NOT_CHECKABLE(exclusion);
  const references = referencesByProperty.get(record.cssProperty) ?? [];
  const wcag = references.filter((reference) => reference.scope === 'wcag');
  if (wcag.length > 0) {
    return {
      coverage: 'statically-checked',
      reason: `Measured in ${wcag.length} WCAG pairing${wcag.length === 1 ? '' : 's'} against the shared contrast table, in all six contexts.`,
      checkedBy: wcag.map((reference) => reference.pairingId),
    };
  }
  const advisoryRule = ADVISORY_RULE_PROPERTIES.get(record.cssProperty);
  if (references.length > 0 || advisoryRule !== undefined) {
    return {
      coverage: 'advisory',
      reason:
        "Only Cinder's stricter guardrails look at this token (decorative border floors, border hierarchy, polarity ink); WCAG sets no threshold for it.",
      checkedBy: [
        ...references.map((reference) => reference.pairingId),
        ...(advisoryRule === undefined ? [] : [advisoryRule]),
      ],
    };
  }
  if (record.cssProperty.startsWith('--cinder-ring-')) {
    return {
      coverage: 'scene-checked',
      reason:
        'Focus ring geometry is verified by the visible and unobscured focus rendered checks.',
      checkedBy: ['rendered-2.4.7-focus-visible', 'rendered-2.4.11-focus-not-obscured'],
    };
  }
  return NOT_CHECKABLE(
    'No known foreground and background pairing uses this color, so its contrast cannot be computed from tokens alone; it is exercised only where a reference scene paints it.',
  );
}

/** Classify one token. A profile no rule covers throws, so growth cannot go unclassified. */
export function classifyToken(record: AuthoringRecord): TokenCoverage {
  let rule: ProfileRule | undefined;
  if (record.profile === 'color') rule = colorRule(record);
  else if (record.profile === 'opacity' && record.cssProperty === '--cinder-opacity-disabled') {
    rule = {
      coverage: 'statically-checked',
      reason:
        'Applied to disabled text in the contrast table; the ratio is recorded as an inactive-component exception.',
      checkedBy: (referencesByProperty.get(record.cssProperty) ?? []).map(
        (reference) => reference.pairingId,
      ),
    };
  } else if (
    record.cssProperty.startsWith('--cinder-ring-') &&
    NON_COLOR_PROFILES[record.profile] !== undefined
  ) {
    rule = {
      coverage: 'scene-checked',
      reason:
        'Focus ring geometry is verified by the visible and unobscured focus rendered checks.',
      checkedBy: ['rendered-2.4.7-focus-visible', 'rendered-2.4.11-focus-not-obscured'],
    };
  } else rule = NON_COLOR_PROFILES[record.profile];
  if (rule === undefined) {
    throw new Error(`No coverage rule for profile "${record.profile}" (${record.path}).`);
  }
  return {
    path: record.path,
    cssProperty: record.cssProperty,
    profile: record.profile,
    coverage: rule.coverage,
    reason: rule.reason,
    checkedBy: rule.checkedBy,
  };
}

/** The ledger for every public registry token. */
export function buildCoverageLedger(
  records: readonly AuthoringRecord[] = AUTHORING_CATALOGUE.records,
): TokenCoverage[] {
  return records.map(classifyToken);
}

export function coverageSummary(ledger: readonly TokenCoverage[]): Record<CoverageClass, number> {
  const summary: Record<CoverageClass, number> = {
    'statically-checked': 0,
    'scene-checked': 0,
    advisory: 0,
    'not-automatically-checkable': 0,
  };
  for (const entry of ledger) summary[entry.coverage] += 1;
  return summary;
}
