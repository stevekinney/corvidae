/**
 * Offering and applying a remediation (COR-487).
 *
 * `proposeForFinding` decides what one finding offers. `applyProposal` is the single Apply:
 * it refuses a proposal whose revision, lock set or target moved, recomputes the proposal
 * from the current draft and refuses it if the recomputed state is not byte-identical to
 * what was shown (the algorithm is deterministic, so any difference means the inputs
 * changed), and only then commits the shown state as ONE undoable `remediation`
 * transaction. Undo restores the previous source and locks exactly, because history holds
 * whole editable states.
 */

import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import type { ThemeDraft } from './theme-draft-types.ts';
import {
  contrastFixFor,
  pairingOf,
  proposeContrastFix,
  type RemediationFailure,
  type RemediationProposal,
  type RemediationRequest,
  type RemediationResult,
} from './theme-remediation-proposal.ts';
import {
  manualInstruction,
  proposeRestoreOrManual,
  proposeRestoreOverrides,
} from './theme-remediation-restore.ts';

/** What a finding offers: a repair, a restore, or the reason none is safe. */
export async function proposeForFinding(request: RemediationRequest): Promise<RemediationResult> {
  const { record } = request;
  if (record.outcome === 'fail' && pairingOf(record) !== undefined) {
    const fix = contrastFixFor(request.draft, record);
    const restore = await proposeRestoreOverrides(request);
    const offer = (failed: RemediationFailure): RemediationFailure => ({
      ...failed,
      restore,
      manual: failed.manual ?? (restore === null ? manualInstruction(record) : null),
    });
    if (!('action' in fix)) return offer(fix);
    const result = await proposeContrastFix(request, fix);
    return result.ok ? result : offer(result);
  }
  return proposeRestoreOrManual(request);
}

/** Recompute the proposal an earlier one was, from the current draft. */
export async function recomputeProposal(
  request: RemediationRequest,
  action: RemediationProposal['action'],
): Promise<RemediationProposal | null> {
  if (action === 'restore-overrides') return proposeRestoreOverrides(request);
  const fix = contrastFixFor(request.draft, request.record);
  if (!('action' in fix)) return null;
  const result = await proposeContrastFix(request, fix);
  return result.ok ? result.proposal : null;
}

/** Why a proposal can no longer be applied to this draft, or `null` when it can. */
export function staleReason(
  proposal: RemediationProposal,
  draft: ThemeDraft | null,
): string | null {
  if (draft === null) return 'No theme is open.';
  const { binding } = proposal;
  if (draft.envelope.id !== binding.envelopeId) return 'A different theme is open now.';
  if (draft.revision !== binding.revision) {
    return `The source changed after this was computed (revision ${binding.revision}, now ${draft.revision}).`;
  }
  if ((draft.envelope.locked ?? []).join('|') !== binding.locks) {
    return 'The locked tokens changed after this was computed.';
  }
  return null;
}

export type ApplyOutcome =
  { ok: true; message: string; findingId: string } | { ok: false; message: string; stale: boolean };

const STALE_HELP = 'Propose the fix again to see current values.';

export async function applyProposal(
  controller: ThemeBuilderController,
  proposal: RemediationProposal,
  recompute: () => Promise<RemediationProposal | null>,
): Promise<ApplyOutcome> {
  const reason = staleReason(proposal, controller.draft);
  if (reason !== null) return { ok: false, stale: true, message: `${reason} ${STALE_HELP}` };
  const fresh = await recompute();
  // The commit queue is serial, but a newer commit may have landed while recomputing.
  const again = staleReason(proposal, controller.draft);
  if (again !== null) return { ok: false, stale: true, message: `${again} ${STALE_HELP}` };
  if (fresh === null || JSON.stringify(fresh.state) !== JSON.stringify(proposal.state)) {
    return {
      ok: false,
      stale: true,
      message: `This proposal no longer holds against the current source, locks and target. ${STALE_HELP}`,
    };
  }
  const outcome = await controller.commit({
    kind: 'remediation',
    label: proposal.title,
    state: proposal.state,
  });
  if (!outcome.ok) return { ok: false, stale: false, message: outcome.message };
  const count = fresh.resolved;
  const message = `${proposal.label} applied. ${count} ${count === 1 ? 'finding' : 'findings'} resolved, none introduced. Undo restores the previous theme.`;
  controller.announcement = message;
  return { ok: true, message, findingId: proposal.binding.findingId };
}
