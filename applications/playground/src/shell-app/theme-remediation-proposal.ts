/**
 * Remediation proposals (COR-487): what a finding offers, computed without touching the
 * draft. A proposal carries the exact state Apply commits, every changed path with its
 * before and after value, the resulting measurements, the gamut and algorithm version, and
 * the revision, lock set and target it is bound to. Any change to those makes it stale.
 *
 * - A failing contrast finding whose foreground is an unlocked literal color is repaired by
 *   the deterministic search in `theme-remediation.ts`.
 * - An alias or recipe foreground is first detached through the same previewed detach path
 *   COR-488 uses (`proposeDetach`), and the repair is part of the same one transaction.
 * - Every proposal passes `compareStates` before it is offered; if it does not, no fix is
 *   offered and the reason is shown instead.
 */

import { CONTRAST_PAIRINGS, type ContrastPairing } from '@lostgradient/cinder/tokens/runtime';

import { catalogueRowByPath } from './theme-builder-catalogue.ts';
import type { ReportRecord } from './theme-check-types.ts';
import type { OutputGamut } from './theme-chroma-grid.ts';
import { readDtcgColor } from './theme-color-model.ts';
import type { ThemeEvaluator } from './theme-draft-evaluation.ts';
import type {
  EditableState,
  OverrideScope,
  ThemeContextId,
  ThemeDraft,
} from './theme-draft-types.ts';
import { applyEdit, type DraftEdit } from './theme-draft.ts';
import { computeImpact } from './theme-impact.ts';
import { proposeDetach } from './theme-reference-edits.ts';
import {
  compareStates,
  envelopeWith,
  findingKey,
  reportForEnvelope,
} from './theme-remediation-check.ts';
import { changeRowsFor, previewContextOf, type ChangeRow } from './theme-remediation-rows.ts';
import {
  measureAffected,
  REMEDIATION_ALGORITHM_VERSION,
  searchForeground,
  type PairingResult,
} from './theme-remediation.ts';
import { authoredValueOf, buildEdit, isAliasValue } from './theme-token-edit.ts';

export type RemediationAction =
  'replace-oklch' | 'detach-and-repair' | 'restore-overrides' | 'restore-last-valid';

export const ACTION_LABELS: Record<RemediationAction, string> = {
  'replace-oklch': 'Replace value with OKLCH',
  'detach-and-repair': 'Detach and repair',
  'restore-overrides': 'Restore affected overrides',
  'restore-last-valid': 'Restore last valid value',
};

export type MeasurementRow = {
  pairingId: string;
  description: string;
  before: number | null;
  after: number | null;
  required: number | null;
  status: PairingResult['status'];
};

/** What a proposal is bound to; any difference at Apply time makes it stale. */
export type ProposalBinding = {
  envelopeId: string;
  revision: number;
  /** The sorted lock set, joined. */
  locks: string;
  /** The finding id the proposal was computed for. */
  findingId: string;
  /** The foreground token, or the restored paths for a restore. */
  target: string;
  context: ThemeContextId;
};

export type RemediationProposal = {
  action: RemediationAction;
  label: string;
  title: string;
  binding: ProposalBinding;
  gamut: OutputGamut;
  algorithmVersion: string;
  /** The exact state Apply commits. */
  state: EditableState;
  changes: readonly ChangeRow[];
  measurements: readonly MeasurementRow[];
  notes: readonly string[];
  /** Findings the regression check found resolved; none are introduced. */
  resolved: number;
};

export type RemediationFailure = {
  ok: false;
  message: string;
  /** Specific blocking constraints, one per line. */
  blockers: readonly string[];
  /** A restore that passes the same regression check, or `null`. */
  restore: RemediationProposal | null;
  /** A precise manual instruction when nothing can be offered as a button. */
  manual: string | null;
};

export type RemediationResult = { ok: true; proposal: RemediationProposal } | RemediationFailure;

export type RemediationRequest = {
  draft: ThemeDraft;
  record: ReportRecord;
  evaluator: ThemeEvaluator;
  gamut: OutputGamut;
};

const PAIRINGS_BY_ID = new Map(CONTRAST_PAIRINGS.map((pairing) => [pairing.id, pairing] as const));

export const failure = (
  message: string,
  extra: Partial<Omit<RemediationFailure, 'ok' | 'message'>> = {},
): RemediationFailure => ({
  ok: false,
  message,
  blockers: [],
  restore: null,
  manual: null,
  ...extra,
});

export const locksOf = (draft: ThemeDraft): string => (draft.envelope.locked ?? []).join('|');

export function bindingFor(
  draft: ThemeDraft,
  record: ReportRecord,
  target: string,
): ProposalBinding {
  return {
    envelopeId: draft.envelope.id,
    revision: draft.revision,
    locks: locksOf(draft),
    findingId: record.id,
    target,
    context: record.context,
  };
}

export function pairingOf(record: ReportRecord): ContrastPairing | undefined {
  return record.pairingId === null ? undefined : PAIRINGS_BY_ID.get(record.pairingId);
}

async function propertiesOf(
  request: RemediationRequest,
  context: ThemeContextId,
): Promise<Record<string, string> | null> {
  const evaluation = await request.evaluator.evaluate(
    request.draft.envelope,
    request.draft.revision,
    context,
  );
  return evaluation.ok
    ? Object.fromEntries(evaluation.properties.map(({ name, value }) => [name, value]))
    : null;
}

export type ContrastFix = {
  action: Extract<RemediationAction, 'replace-oklch' | 'detach-and-repair'>;
  record: ReportRecord;
  path: string;
  scope: OverrideScope;
  mode: 'literal' | 'alias' | 'recipe';
};

/** Which fix, if any, a failing contrast finding can offer at all, before any search. */
export function contrastFixFor(
  draft: ThemeDraft,
  record: ReportRecord,
): ContrastFix | RemediationFailure {
  const foreground = record.stack.find((entry) => entry.role === 'foreground');
  const path = foreground?.tokenPath ?? null;
  if (record.outcome !== 'fail' || pairingOf(record) === undefined || path === null) {
    return failure('This finding is not a contrast failure with a foreground token.');
  }
  const row = catalogueRowByPath(path);
  const where = `${path} in ${record.context}`;
  if (row === undefined) return failure(`${path} is not an editable token.`);
  if ((draft.envelope.locked ?? []).includes(path)) {
    return failure(`${path} is locked, so no fix may change it. Unlock it to allow a fix.`, {
      manual: `Unlock ${path} to let a fix change it, or choose a different foreground by hand.`,
    });
  }
  if (row.edit === 'css-only') {
    return failure(`${where} is a CSS-only value, which a fix does not rewrite.`, {
      manual: `Change the CSS value of ${path} in ${record.context} so it contrasts with its background.`,
    });
  }
  const context = previewContextOf(record.context);
  const authored = authoredValueOf(draft.envelope, context, path);
  const scope: OverrideScope = context.colorMode;
  let mode: ContrastFix['mode'] = 'literal';
  if (isAliasValue(authored)) mode = 'alias';
  else if (readDtcgColor(authored) === null) {
    if (row.edit !== 'recipe') {
      return failure(`${where} is not a literal color, so a fix cannot replace it.`);
    }
    mode = 'recipe';
  }
  return {
    action: mode === 'literal' ? 'replace-oklch' : 'detach-and-repair',
    record,
    path,
    scope,
    mode,
  };
}

/** Compute the contrast repair for a finding, with the regression check applied. */
export async function proposeContrastFix(
  request: RemediationRequest,
  fix: ContrastFix,
): Promise<RemediationResult> {
  const { draft, record, gamut } = request;
  const pairing = pairingOf(record)!;
  const foreground = record.stack.find((entry) => entry.role === 'foreground')!;
  const properties = await propertiesOf(request, record.context);
  if (properties === null)
    return failure('This context does not evaluate, so nothing can be measured.');
  const context = previewContextOf(record.context);
  const search = searchForeground({
    property: foreground.cssProperty,
    properties,
    pairings: CONTRAST_PAIRINGS,
    findingPairingId: pairing.id,
    theme: context.colorMode,
    gamut,
  });
  if (!search.ok) {
    return failure(search.message, {
      blockers: search.blockers.map((blocker) =>
        blocker.reachableAlone
          ? `${blocker.description}: can pass alone (best ${blocker.bestRatio?.toFixed(2)}:1).`
          : `${blocker.description}: needs ${blocker.required}:1, best reachable ${blocker.bestRatio?.toFixed(2) ?? 'none'}:1.`,
      ),
    });
  }

  const row = catalogueRowByPath(fix.path)!;
  const value = {
    colorSpace: 'oklch',
    components: [search.candidate.l, search.candidate.c, search.candidate.h],
    ...(search.candidate.alpha === 1 ? {} : { alpha: search.candidate.alpha }),
  };
  const notes = [
    `Replaces ${fix.path} in the ${context.colorMode} color mode with an OKLCH literal. Hue and alpha are kept; the background, other color modes and locked tokens are not changed.`,
    `Lightness moves ${search.deltaLightness >= 0 ? '+' : ''}${search.deltaLightness} and chroma is reduced on the 101-step grid (step ${search.chromaStep} of 100) to stay inside ${gamut === 'srgb' ? 'sRGB' : 'Display P3'} without clipping.`,
    'The same override applies to every motion setting of this color mode.',
  ];
  let base: ThemeDraft = draft;
  const edits: DraftEdit[] = [];
  if (fix.mode !== 'literal') {
    const detached = proposeDetach(draft, row, context, fix.scope);
    if (!detached.ok) return failure(detached.message);
    const replace: DraftEdit = { kind: 'replace', state: detached.impact.state };
    const applied = applyEdit(draft, replace);
    if (!applied.ok) return failure('The detached theme exceeds a size limit.');
    base = applied.draft;
    edits.push(replace);
    notes.unshift(
      `${fix.path} is a ${fix.mode === 'alias' ? 'linked alias' : 'recipe'}. Detaching it replaces the link with its literal value first, as one visible change; Undo restores the link.`,
    );
  }
  const built = buildEdit(row, base.envelope, context, fix.scope, JSON.stringify(value));
  if (!built.ok) return failure(`${fix.path}: ${built.message}`);
  edits.push(built.edit);
  const impact = computeImpact(draft, fix.path, edits);
  if (!impact.ok) return failure(impact.message);

  const measurements = measurementRows(properties, context.colorMode, search.results);
  const proposal: RemediationProposal = {
    action: fix.action,
    label: ACTION_LABELS[fix.action],
    title: `${ACTION_LABELS[fix.action]}: ${fix.path} in ${context.colorMode}`,
    binding: bindingFor(draft, record, fix.path),
    gamut,
    algorithmVersion: REMEDIATION_ALGORITHM_VERSION,
    state: impact.state,
    changes: changeRowsFor(impact, draft),
    measurements,
    notes,
    resolved: 0,
  };
  return verify(request, proposal);
}

function measurementRows(
  properties: Readonly<Record<string, string>>,
  theme: 'light' | 'dark',
  after: readonly PairingResult[],
): MeasurementRow[] {
  return after.map((result) => {
    const pairing = PAIRINGS_BY_ID.get(result.pairingId)!;
    const earlier = measureAffected(pairing, properties, theme);
    return {
      pairingId: result.pairingId,
      description: result.description,
      before: earlier.ratio,
      after: result.ratio,
      required: result.required,
      status: result.status,
    };
  });
}

/** Run the regression check over all six contexts and fold the outcome into the proposal. */
export async function verify(
  request: RemediationRequest,
  proposal: RemediationProposal,
): Promise<RemediationResult> {
  const { draft, evaluator, record } = request;
  const current = await reportForEnvelope(evaluator, draft.envelope, draft.revision);
  const proposed = await reportForEnvelope(
    evaluator,
    envelopeWith(draft.envelope, proposal.state),
    draft.revision + 1,
  );
  const outcome = compareStates(current, proposed, {
    key: findingKey(record),
    colorMode: previewContextOf(record.context).colorMode,
  });
  if (!outcome.ok) return failure(outcome.message);
  return { ok: true, proposal: { ...proposal, resolved: outcome.resolved } };
}
