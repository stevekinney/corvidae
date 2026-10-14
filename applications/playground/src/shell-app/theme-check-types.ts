/**
 * The accessibility report's schema (COR-259). COR-487's remediation consumes these shapes, so
 * every record carries a stable id, token paths, the pairing and its composited stack, and the
 * measured and required values.
 *
 * Four outcome sets are reported side by side and never overwrite one another: source validity
 * (DTCG and the runtime's semantic checks), the Cinder profile, WCAG results, and advisory
 * results (Cinder's stricter guardrails, APCA, gamut). Only the first three can change status.
 */

import type { ThemeContextId } from './theme-draft-types.ts';

export type Severity = 'invalid-source' | 'accessibility-error' | 'needs-review' | 'advisory';
export const SEVERITIES: readonly Severity[] = [
  'invalid-source',
  'accessibility-error',
  'needs-review',
  'advisory',
];

export type OutcomeSetId = 'source-validity' | 'cinder-profile' | 'wcag' | 'advisory';

/** `pass` met the threshold, `exempt` is a classified exception, `fail` carries a severity. */
export type Outcome = 'pass' | 'exempt' | 'fail' | 'needs-review';

export type SceneReference = { sceneId: string; state: string; background: string };

export type StackEntry = {
  role: 'foreground' | 'background' | 'backdrop';
  cssProperty: string;
  tokenPath: string | null;
  value: string;
  /** The gamma-encoded sRGB the measurement used, after clamping. */
  rgb: { r: number; g: number; b: number; alpha: number };
};

export type ReportRecord = {
  /** `<ruleId>:<subject>:<context>`; stable across runs and revisions. */
  id: string;
  ruleId: string;
  outcomeSet: OutcomeSetId;
  outcome: Outcome;
  /** `null` for a pass or an exempt record. */
  severity: Severity | null;
  message: string;
  /** The measured value, unrounded, or `null` when nothing could be measured. */
  measured: number | null;
  /** The required value, or `null` when the rule sets no threshold. */
  required: number | null;
  unit: 'ratio' | 'lc' | 'delta-e' | 'chroma' | 'spread' | 'none';
  tokenPaths: string[];
  cssProperties: string[];
  /** The pairing id for contrast records, or `null`. */
  pairingId: string | null;
  classification: string | null;
  /** The foreground, background and any backdrop, in paint order. */
  stack: StackEntry[];
  scenes: SceneReference[];
  context: ThemeContextId;
  sourceRevision: number;
  exceptions: string[];
  untested: string[];
  /** The seam COR-487 fills with fix actions. Always empty here. */
  actions: readonly never[];
};

export type SourceValidityOutcome =
  | { status: 'valid' }
  | {
      status: 'invalid';
      diagnostics: Array<{ context: ThemeContextId; path: string; message: string }>;
    };

export type AccessibilityReport = {
  /** What the results are valid for: one theme, one revision, all six contexts. */
  stamp: { themeId: string; sourceRevision: number; contexts: readonly ThemeContextId[] };
  sourceValidity: SourceValidityOutcome;
  /** Present only when every context evaluated. */
  records: {
    cinderProfile: ReportRecord[];
    wcag: ReportRecord[];
    advisory: ReportRecord[];
  };
  /** What no automated check in this report covers. */
  untested: string[];
};

export type ReportCounts = Record<Severity, number> & { pass: number; exempt: number };

export type ExportReadiness =
  | 'checking'
  | 'stale'
  | 'blocked-invalid-source'
  | 'blocked-accessibility-errors'
  | 'needs-review'
  | 'ready';
