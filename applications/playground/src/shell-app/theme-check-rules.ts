/**
 * The check rule ledger (COR-259): every rule the theme builder's accessibility report can
 * emit or defers to rendered and manual evidence. A rule names the criterion it is evidence
 * for, how it measures, the severity a failure carries, the exception it recognises, and the
 * fixture that pins it. Reports reference rules by id; nothing in the report invents one.
 *
 * Results are scoped checks of the committed revision, the six contexts and the reference
 * scenes. No rule here supports an "Accessible" or "WCAG certified" claim.
 */

import type { OutcomeSetId, Severity } from './theme-check-types.ts';

export type RuleMethod = 'static' | 'rendered' | 'manual';

export type CheckRule = {
  id: string;
  title: string;
  outcomeSet: OutcomeSetId | 'rendered';
  /** WCAG 2.2 success criterion, or `null` for a Cinder rule. */
  criterion: string | null;
  method: RuleMethod;
  /** How the rule is measured, in one sentence. */
  measurement: string;
  /** The severity a failed measurement carries, or `null` when the rule never fails a report. */
  severity: Severity | null;
  /** The exception the rule recognises, or `null`. */
  exception: string | null;
  /** The test that pins the rule. */
  fixture: string;
};

const ENGINE_TEST = 'applications/playground/src/shell-app/theme-accessibility.test.ts';
const RENDERED_TEST = 'applications/playground/tests/theme-builder-accessibility.playwright.ts';

export const CHECK_RULES: readonly CheckRule[] = [
  {
    id: 'source-validity',
    title: 'Theme source validates',
    outcomeSet: 'source-validity',
    criterion: null,
    method: 'static',
    measurement:
      'The token runtime validates the source against DTCG 2025.10 and its semantic rules in all six contexts.',
    severity: 'invalid-source',
    exception: null,
    fixture: ENGINE_TEST,
  },
  {
    id: 'cinder-profile-range',
    title: 'Values stay inside the Cinder usage profile',
    outcomeSet: 'cinder-profile',
    criterion: null,
    method: 'static',
    measurement:
      'Each numeric public value is compared with its profile range (for example opacity between 0 and 1).',
    severity: 'advisory',
    exception: 'Values the projection leaves as an alias or recipe are measured at their target.',
    fixture: ENGINE_TEST,
  },
  {
    id: 'wcag-1.4.3-text-contrast',
    title: 'Text contrast (minimum)',
    outcomeSet: 'wcag',
    criterion: '1.4.3',
    method: 'static',
    measurement:
      'Unrounded WCAG contrast of text over its composited background is at least 4.5:1.',
    severity: 'accessibility-error',
    exception:
      'A pairing is measured as large text (3:1) only when its rendered size is known and at least 24 CSS px, or at least 18.6667 CSS px and bold (700). No pairing here records a size, so every text pairing is held to 4.5:1.',
    fixture: ENGINE_TEST,
  },
  {
    id: 'wcag-1.4.3-large-text-contrast',
    title: 'Large text contrast (minimum)',
    outcomeSet: 'wcag',
    criterion: '1.4.3',
    method: 'static',
    measurement:
      'Unrounded contrast of known large text over its composited background is at least 3:1.',
    severity: 'accessibility-error',
    exception: 'Only text whose rendered size and weight meet the large-text definition.',
    fixture: ENGINE_TEST,
  },
  {
    id: 'wcag-1.4.11-non-text-contrast',
    title: 'Non-text contrast',
    outcomeSet: 'wcag',
    criterion: '1.4.11',
    method: 'static',
    measurement:
      'Unrounded contrast of a control boundary, focus indicator or essential graphic against its adjacent color is at least 3:1.',
    severity: 'accessibility-error',
    exception:
      'Purely decorative separators are classified separately and are not measured against 3:1.',
    fixture: ENGINE_TEST,
  },
  {
    id: 'wcag-inactive-component',
    title: 'Inactive component (disabled) contrast',
    outcomeSet: 'wcag',
    criterion: '1.4.3',
    method: 'static',
    measurement: 'The ratio is recorded for disabled foregrounds but sets no threshold.',
    severity: null,
    exception: 'WCAG exempts text and graphics of inactive user interface components.',
    fixture: ENGINE_TEST,
  },
  {
    id: 'wcag-needs-review',
    title: 'Contrast could not be measured',
    outcomeSet: 'wcag',
    criterion: '1.4.3',
    method: 'static',
    measurement:
      'A gradient, image, unknown or translucent background, missing value or unsupported color syntax cannot be reduced to a ratio.',
    severity: 'needs-review',
    exception: null,
    fixture: ENGINE_TEST,
  },
  {
    id: 'cinder-decorative-border-floor',
    title: 'Decorative borders stay perceptible',
    outcomeSet: 'advisory',
    criterion: null,
    method: 'static',
    measurement:
      'Muted, faint and status borders keep Cinder’s floor (1.4:1, and 1.1:1 for faint hairlines) against their surface.',
    severity: 'advisory',
    exception: 'WCAG sets no contrast for a purely decorative separator.',
    fixture: ENGINE_TEST,
  },
  {
    id: 'cinder-border-hierarchy',
    title: 'Border tiers read consistently and stay ordered',
    outcomeSet: 'advisory',
    criterion: null,
    method: 'static',
    measurement:
      'Each structural border tier reads within 15% across the four legal surfaces, and strong > control > muted on every surface.',
    severity: 'advisory',
    exception: null,
    fixture: ENGINE_TEST,
  },
  {
    id: 'cinder-chart-distinguishability',
    title: 'Chart series stay distinguishable',
    outcomeSet: 'advisory',
    criterion: null,
    method: 'static',
    measurement:
      'Series chroma is at least 0.06, pairwise CIEDE2000 is at least 12 and CIE L* separation is at least 4.',
    severity: 'advisory',
    exception:
      'Not a color-vision-deficiency proof; series also need a non-color cue in the chart.',
    fixture: ENGINE_TEST,
  },
  {
    id: 'cinder-polarity-ink',
    title: 'Polarity ink opposes its surfaces',
    outcomeSet: 'advisory',
    criterion: null,
    method: 'static',
    measurement: 'The ink washes are built from reads at least 4.5:1 on every legal surface.',
    severity: 'advisory',
    exception: null,
    fixture: ENGINE_TEST,
  },
  {
    id: 'apca-lightness-contrast',
    title: 'APCA lightness contrast',
    outcomeSet: 'advisory',
    criterion: null,
    method: 'static',
    measurement:
      'APCA Lc for text pairings is reported against Lc 60. It informs, and never replaces, the WCAG 2.2 ratio.',
    severity: 'advisory',
    exception: 'Not a WCAG 2.2 requirement.',
    fixture: ENGINE_TEST,
  },
  {
    id: 'gamut-clamped',
    title: 'Color is inside the sRGB gamut',
    outcomeSet: 'advisory',
    criterion: null,
    method: 'static',
    measurement:
      'A color outside sRGB is measured after clamping; a valid DTCG color can still exceed what the output renders.',
    severity: 'advisory',
    exception: null,
    fixture: ENGINE_TEST,
  },
  {
    id: 'rendered-1.4.4-resize-text',
    title: 'Text resizes to 200%',
    outcomeSet: 'rendered',
    criterion: '1.4.4',
    method: 'rendered',
    measurement: 'The reference scenes keep content and function with the root text size doubled.',
    severity: null,
    exception: null,
    fixture: RENDERED_TEST,
  },
  {
    id: 'rendered-1.4.10-reflow',
    title: 'Content reflows at 320 CSS px',
    outcomeSet: 'rendered',
    criterion: '1.4.10',
    method: 'rendered',
    measurement:
      'The builder and preview scenes show no horizontal page scroll at a 320 CSS px viewport.',
    severity: null,
    exception:
      'Data tables and charts that need two dimensions may scroll inside their own region.',
    fixture: RENDERED_TEST,
  },
  {
    id: 'rendered-1.4.12-text-spacing',
    title: 'Text spacing overrides',
    outcomeSet: 'rendered',
    criterion: '1.4.12',
    method: 'rendered',
    measurement:
      'With line height 1.5, paragraph spacing 2em, letter spacing .12em and word spacing .16em applied, no text is clipped or lost.',
    severity: null,
    exception: null,
    fixture: RENDERED_TEST,
  },
  {
    id: 'rendered-2.1-keyboard',
    title: 'Keyboard operation and no trap',
    outcomeSet: 'rendered',
    criterion: '2.1.1, 2.1.2',
    method: 'rendered',
    measurement:
      'Focus moves through the builder with Tab and leaves every region; a human keyboard walkthrough covers the rest.',
    severity: null,
    exception: null,
    fixture: RENDERED_TEST,
  },
  {
    id: 'rendered-2.4.7-focus-visible',
    title: 'Keyboard focus is visible',
    outcomeSet: 'rendered',
    criterion: '2.4.7',
    method: 'rendered',
    measurement: 'The focused control paints a focus indicator in the reference scenes.',
    severity: null,
    exception: null,
    fixture: RENDERED_TEST,
  },
  {
    id: 'rendered-2.4.11-focus-not-obscured',
    title: 'Focus is not obscured',
    outcomeSet: 'rendered',
    criterion: '2.4.11',
    method: 'rendered',
    measurement: 'The focused control is not covered by sticky or overlapping content.',
    severity: null,
    exception: null,
    fixture: RENDERED_TEST,
  },
  {
    id: 'rendered-2.5.8-target-size',
    title: 'Targets are at least 24 by 24 CSS px',
    outcomeSet: 'rendered',
    criterion: '2.5.8',
    method: 'rendered',
    measurement:
      'Each visible button, checkbox, tab and link target measures at least 24 by 24 CSS px.',
    severity: null,
    exception:
      'Inline links within a sentence, and targets with enough clear spacing, are recorded as documented exceptions.',
    fixture: RENDERED_TEST,
  },
  {
    id: 'manual-3.3-errors-and-labels',
    title: 'Error identification, labels and instructions',
    outcomeSet: 'rendered',
    criterion: '3.3.1, 3.3.2',
    method: 'manual',
    measurement:
      'Axe checks for programmatic names and error association; whether the wording is helpful needs a person.',
    severity: null,
    exception: null,
    fixture: RENDERED_TEST,
  },
  {
    id: 'manual-4.1.2-name-role-value',
    title: 'Name, role, value',
    outcomeSet: 'rendered',
    criterion: '4.1.2',
    method: 'manual',
    measurement:
      'Axe covers computed names and roles on the builder and preview scenes; custom widget behavior needs assistive technology.',
    severity: null,
    exception: null,
    fixture: RENDERED_TEST,
  },
  {
    id: 'rendered-forced-colors',
    title: 'Forced colors',
    outcomeSet: 'rendered',
    criterion: null,
    method: 'rendered',
    measurement:
      'With forced colors active the scenes keep readable text and visible control boundaries.',
    severity: null,
    exception: null,
    fixture: RENDERED_TEST,
  },
  {
    id: 'rendered-reduced-motion',
    title: 'Reduced motion',
    outcomeSet: 'rendered',
    criterion: '2.3.3',
    method: 'rendered',
    measurement:
      'The user’s own prefers-reduced-motion is inspected separately from the preview’s simulated motion setting; builder chrome always follows the user.',
    severity: null,
    exception: null,
    fixture: RENDERED_TEST,
  },
];

export function ruleById(id: string): CheckRule {
  const rule = CHECK_RULES.find((candidate) => candidate.id === id);
  if (rule === undefined) throw new Error(`Unknown check rule: ${id}`);
  return rule;
}

/** The WCAG criteria the static engine cannot prove and a rendered or manual check carries. */
export const NON_STATIC_CRITERIA = [
  '1.4.4',
  '1.4.10',
  '1.4.12',
  '2.1.1',
  '2.1.2',
  '2.4.7',
  '2.4.11',
  '2.5.8',
  '3.3.1',
  '3.3.2',
  '4.1.2',
] as const;
