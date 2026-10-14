/**
 * Applying a preflighted import (COR-486). The preflight has already refused everything unsafe
 * or invalid; this commits the one supported candidate, either as a single undoable
 * transaction on the open theme or as a new theme. The controller validates the candidate in
 * all six contexts again before anything changes, so a rejection leaves the draft, history,
 * storage and preview exactly as they were.
 */

import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import { preflightImport } from './theme-import-preflight.ts';
import { canApply, type PreflightResult } from './theme-import-types.ts';

export type ApplyMode = 'replace' | 'copy';
export type ApplyResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * The preflight is run again against the draft as it is now, so an overlay never lands on a
 * revision that moved while the dialog was open.
 */
async function freshCandidate(
  controller: ThemeBuilderController,
  result: PreflightResult,
): Promise<PreflightResult> {
  const current = controller.draft?.envelope;
  if ('file' in result.source || current === undefined) return result;
  return preflightImport(result.source.text, result.source.filename, current);
}

export async function applyImport(
  controller: ThemeBuilderController,
  preflight: PreflightResult,
  mode: ApplyMode,
): Promise<ApplyResult> {
  if (!canApply(preflight)) {
    return { ok: false, message: 'This input cannot be applied. Your draft is unchanged.' };
  }
  const result = await freshCandidate(controller, preflight);
  const candidate = result.candidate;
  if (!canApply(result) || candidate === null) {
    return { ok: false, message: 'The input no longer validates. Your draft is unchanged.' };
  }
  if (mode === 'copy') {
    const copied = await controller.importAsCopy(candidate.envelope);
    return copied.ok
      ? { ok: true, message: 'Imported as a new theme.' }
      : { ok: false, message: copied.message };
  }
  const state =
    candidate.kind === 'overlay'
      ? candidate.state
      : { overrides: candidate.envelope.overrides, cssOverrides: candidate.envelope.cssOverrides };
  const label = candidate.kind === 'overlay' ? 'Import DTCG tokens' : 'Import Cinder theme';
  const outcome = await controller.commit({ kind: 'import', label, state });
  if (!outcome.ok) return { ok: false, message: `${outcome.message} Your draft is unchanged.` };
  return {
    ok: true,
    message: outcome.changed
      ? `${label} applied. Undo restores the previous draft.`
      : 'The import changed nothing.',
  };
}
