/**
 * What the remediation control acts on (COR-487): one failing finding, or one invalid-source
 * diagnostic. A subject knows how to compute its proposal and how to recompute it at Apply
 * time; the control renders the same way for both.
 */

import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import type { OutputGamut } from './theme-chroma-grid.ts';
import type { ReportRecord } from './theme-check-types.ts';
import type { ThemeEvaluator } from './theme-draft-evaluation.ts';
import { proposeForFinding, recomputeProposal } from './theme-remediation-apply.ts';
import {
  contrastFixFor,
  failure,
  pairingOf,
  type RemediationProposal,
  type RemediationRequest,
  type RemediationResult,
} from './theme-remediation-proposal.ts';
import { proposeRestoreLastValid, type SourceDiagnostic } from './theme-remediation-restore.ts';

export type RemediationSubject = {
  /** Stable key for focus and tests. */
  id: string;
  /** The text the control's first button shows. */
  buttonLabel: string;
  /** The accessible name of that button, with the finding and context. */
  buttonName: string;
  propose(): Promise<RemediationResult>;
  recompute(proposal: RemediationProposal): Promise<RemediationProposal | null>;
};

export function findingSubject(
  controller: ThemeBuilderController,
  record: ReportRecord,
  title: string,
  evaluator: ThemeEvaluator,
  gamut: OutputGamut,
): RemediationSubject {
  const request = (): RemediationRequest | null => {
    const draft = controller.draft;
    return draft === null ? null : { draft, record, evaluator, gamut };
  };
  const draft = controller.draft;
  const fix =
    draft !== null && record.outcome === 'fail' && pairingOf(record) !== undefined
      ? contrastFixFor(draft, record)
      : null;
  const detach = fix !== null && 'action' in fix && fix.action === 'detach-and-repair';
  const buttonLabel = detach ? 'Detach and repair' : 'Review a fix';
  return {
    id: record.id,
    buttonLabel,
    buttonName: `${buttonLabel}: ${title}, ${record.context}`,
    async propose() {
      const next = request();
      return next === null ? failure('No theme is open.') : proposeForFinding(next);
    },
    async recompute(proposal) {
      const next = request();
      return next === null ? null : recomputeProposal(next, proposal.action);
    },
  };
}

export function diagnosticSubject(
  controller: ThemeBuilderController,
  diagnostic: SourceDiagnostic,
  evaluator: ThemeEvaluator,
): RemediationSubject {
  const compute = async (): Promise<RemediationProposal | null> => {
    const draft = controller.draft;
    const history = controller.history;
    if (draft === null || history === null) return null;
    return proposeRestoreLastValid(draft, history, evaluator, diagnostic);
  };
  return {
    id: `source-validity:${diagnostic.path}:${diagnostic.context}`,
    buttonLabel: 'Restore last valid value',
    buttonName: `Restore last valid value: ${diagnostic.path}, ${diagnostic.context}`,
    async propose() {
      const proposal = await compute();
      if (proposal !== null) return { ok: true, proposal };
      return failure('No earlier revision with a valid source restores this token.', {
        manual: `Edit ${diagnostic.path} by hand in ${diagnostic.context}: ${diagnostic.message}. No alias target is guessed for you.`,
      });
    },
    recompute: () => compute(),
  };
}
