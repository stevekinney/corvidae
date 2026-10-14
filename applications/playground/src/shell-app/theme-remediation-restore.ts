/**
 * The restore fallbacks (COR-487). None of them guesses a value:
 *
 * - "Restore affected overrides" removes the draft's own overrides of the tokens a finding
 *   names, in that finding's color mode, so they read the shipped base again. It is offered
 *   only when the result passes the same regression check as any other proposal.
 * - "Restore last valid value" returns the token an invalid-source diagnostic names to the
 *   value it had in the newest earlier revision whose source was valid. It never picks an
 *   alias target.
 * - A finding with neither gets a precise manual instruction and no button.
 */

import { CONTRAST_PAIRINGS } from '@lostgradient/cinder/tokens/runtime';

import { ruleById } from './theme-check-rules.ts';
import type { ReportRecord } from './theme-check-types.ts';
import type { ThemeEvaluator } from './theme-draft-evaluation.ts';
import {
  editableState,
  OVERRIDE_SCOPES,
  type EditableState,
  type JsonObject,
  type ThemeContextId,
  type ThemeDraft,
} from './theme-draft-types.ts';
import type { ThemeHistory } from './theme-history.ts';
import { computeImpact } from './theme-impact.ts';
import { getNode, jsonEquals, removeNode, setNode } from './theme-override-tree.ts';
import { envelopeWith, reportForEnvelope } from './theme-remediation-check.ts';
import {
  ACTION_LABELS,
  bindingFor,
  failure,
  verify,
  type MeasurementRow,
  type RemediationProposal,
  type RemediationRequest,
  type RemediationResult,
} from './theme-remediation-proposal.ts';
import { changeRowsFor, previewContextOf } from './theme-remediation-rows.ts';
import {
  affectedPairings,
  measureAffected,
  readersOf,
  REMEDIATION_ALGORITHM_VERSION,
} from './theme-remediation.ts';
import { sourcePathOf } from './theme-token-edit.ts';

/** The state with the named tokens' overrides removed in one color mode, or `null`. */
export function withoutOverrides(
  draft: ThemeDraft,
  paths: readonly string[],
  colorMode: 'light' | 'dark',
): EditableState | null {
  const state = editableState(draft.envelope);
  let tree = state.overrides[colorMode];
  let css = state.cssOverrides;
  let removed = false;
  for (const path of paths) {
    const sourcePath = sourcePathOf(draft.envelope, path);
    if (getNode(tree, sourcePath) !== undefined) {
      tree = removeNode(tree, sourcePath);
      removed = true;
    }
    const own = css[path];
    if (own !== undefined) {
      const remaining = Object.fromEntries(
        Object.entries(own).filter(([context]) => !context.startsWith(`${colorMode}/`)),
      );
      if (Object.keys(remaining).length !== Object.keys(own).length) {
        const { [path]: _gone, ...others } = css;
        css = Object.keys(remaining).length === 0 ? others : { ...others, [path]: remaining };
        removed = true;
      }
    }
  }
  if (!removed) return null;
  return { ...state, overrides: { ...state.overrides, [colorMode]: tree }, cssOverrides: css };
}

async function measurementsAfter(
  request: RemediationRequest,
  state: EditableState,
): Promise<MeasurementRow[]> {
  const { draft, record, evaluator } = request;
  const read = async (envelope: ThemeDraft['envelope'], revision: number) => {
    const evaluation = await evaluator.evaluate(envelope, revision, record.context);
    return evaluation.ok
      ? Object.fromEntries(evaluation.properties.map(({ name, value }) => [name, value]))
      : null;
  };
  const before = await read(draft.envelope, draft.revision);
  const after = await read(envelopeWith(draft.envelope, state), draft.revision + 1);
  if (before === null || after === null) return [];
  const names = new Set(record.cssProperties.flatMap((name) => [...readersOf(before, name)]));
  const theme = previewContextOf(record.context).colorMode;
  return affectedPairings(CONTRAST_PAIRINGS, names).map((pairing) => {
    const earlier = measureAffected(pairing, before, theme);
    const later = measureAffected(pairing, after, theme);
    return {
      pairingId: pairing.id,
      description: pairing.description,
      before: earlier.ratio,
      after: later.ratio,
      required: later.required,
      status: later.status,
    };
  });
}

/** "Restore affected overrides" for a finding, or `null` when it is not offerable. */
export async function proposeRestoreOverrides(
  request: RemediationRequest,
): Promise<RemediationProposal | null> {
  const { draft, record } = request;
  const locked = new Set(draft.envelope.locked ?? []);
  const paths = [...new Set(record.tokenPaths)].filter((path) => !locked.has(path));
  const colorMode = previewContextOf(record.context).colorMode;
  const state = withoutOverrides(draft, paths, colorMode);
  if (state === null) return null;
  const impact = computeImpact(draft, paths[0] ?? '', [{ kind: 'replace', state }]);
  if (!impact.ok) return null;
  const proposal: RemediationProposal = {
    action: 'restore-overrides',
    label: ACTION_LABELS['restore-overrides'],
    title: `Restore affected overrides in ${colorMode} mode`,
    binding: bindingFor(draft, record, paths.join(',')),
    gamut: request.gamut,
    algorithmVersion: REMEDIATION_ALGORITHM_VERSION,
    state: impact.state,
    changes: changeRowsFor(impact, draft),
    measurements: await measurementsAfter(request, impact.state),
    notes: [
      `Removes your overrides of ${paths.join(', ')} in the ${colorMode} color mode so they read the shipped value again. Nothing is invented, and locked tokens are kept.`,
    ],
    resolved: 0,
  };
  const checked = await verify(request, proposal);
  return checked.ok ? checked.proposal : null;
}

/** A precise instruction for a finding no button can fix safely. */
export function manualInstruction(record: ReportRecord): string {
  const where =
    record.tokenPaths.length === 0 ? 'the affected tokens' : record.tokenPaths.join(', ');
  const rule = ruleById(record.ruleId);
  return `Edit ${where} by hand in ${record.context}: ${record.message} (${rule.title}). Then check that this finding is gone.`;
}

/** The offer for a finding that is not a contrast repair: a safe restore, or the manual step. */
export async function proposeRestoreOrManual(
  request: RemediationRequest,
): Promise<RemediationResult> {
  const restore = await proposeRestoreOverrides(request);
  if (restore !== null) return { ok: true, proposal: restore };
  return failure('No automatic fix is safe for this finding.', {
    manual: manualInstruction(request.record),
  });
}

// --- invalid source ---------------------------------------------------------------------------

export type SourceDiagnostic = { context: ThemeContextId; path: string; message: string };

/** The override path an invalid-source diagnostic points into, trimmed of `$value` suffixes. */
function overridePathOf(draft: ThemeDraft, diagnosticPath: string): string | null {
  const segments = diagnosticPath.split('.').filter((segment) => segment !== '');
  for (let length = segments.length; length > 0; length -= 1) {
    const candidate = segments.slice(0, length).join('.');
    if (segments[length - 1]!.startsWith('$') && length > 1) continue;
    if (
      OVERRIDE_SCOPES.some(
        (scope) => getNode(draft.envelope.overrides[scope], candidate) !== undefined,
      )
    ) {
      return candidate;
    }
  }
  return null;
}

async function isValid(
  evaluator: ThemeEvaluator,
  draft: ThemeDraft,
  state: EditableState,
): Promise<boolean> {
  const { report } = await reportForEnvelope(
    evaluator,
    envelopeWith(draft.envelope, state),
    draft.revision + 1,
  );
  return report.sourceValidity.status === 'valid';
}

/**
 * Restore the token a diagnostic names to its value in the newest earlier valid revision.
 * Returns `null` when no earlier revision is valid or the diagnostic names no override.
 */
export async function proposeRestoreLastValid(
  draft: ThemeDraft,
  history: ThemeHistory,
  evaluator: ThemeEvaluator,
  diagnostic: SourceDiagnostic,
): Promise<RemediationProposal | null> {
  const path = overridePathOf(draft, diagnostic.path);
  if (path === null) return null;
  const current = editableState(draft.envelope);
  // The states before the current one, newest first, ending at the baseline.
  const states: EditableState[] = [];
  for (let applied = history.cursor - 1; applied >= 1; applied -= 1) {
    states.push(history.entries[applied - 1]?.state ?? history.baseline);
  }
  if (history.cursor > 0) states.push(history.baseline);
  for (const earlier of states) {
    let overrides = current.overrides;
    for (const scope of OVERRIDE_SCOPES) {
      const node = getNode(earlier.overrides[scope], path);
      const tree: JsonObject =
        node === undefined
          ? removeNode(overrides[scope], path)
          : setNode(overrides[scope], path, node);
      overrides = { ...overrides, [scope]: tree };
    }
    const state: EditableState = { ...current, overrides };
    if (jsonEquals(state.overrides, current.overrides)) continue;
    if (!(await isValid(evaluator, draft, state))) continue;
    const impact = computeImpact(draft, path, [{ kind: 'replace', state }]);
    return {
      action: 'restore-last-valid',
      label: ACTION_LABELS['restore-last-valid'],
      title: `Restore last valid value of ${path}`,
      binding: {
        envelopeId: draft.envelope.id,
        revision: draft.revision,
        locks: (draft.envelope.locked ?? []).join('|'),
        findingId: `source-validity:${diagnostic.path}:${diagnostic.context}`,
        target: path,
        context: diagnostic.context,
      },
      gamut: 'srgb',
      algorithmVersion: REMEDIATION_ALGORITHM_VERSION,
      state,
      changes: impact.ok ? changeRowsFor(impact, draft) : [],
      measurements: [],
      notes: [
        `Returns ${path} to the value it had in the newest earlier revision whose source was valid. No alias target is guessed.`,
      ],
      resolved: 1,
    };
  }
  return null;
}
