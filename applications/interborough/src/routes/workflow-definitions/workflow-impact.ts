/**
 * What the edit page says about saving its draft (board PageWorkflowBuilder, "Edit workflow"): the
 * compatibility notice above the footer, from `bureau.workflows.impact`. A compatible edit is one
 * line; a breaking one says each breaking change, what happens to the runs in flight, that later
 * runs use the new version, and that renaming a step is never breaking. A draft that makes no new
 * version has no notice. Plain functions, so the words are tested without a page.
 */
import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import type {
  SavedWorkflowVersion,
  WorkflowImpact,
  WorkflowImpactChange,
} from '../../lib/workflow-files.ts';

const copy = WORKFLOW_COPY.editor.impact;

/** The notice: its tone, its first line, and the sentences under it for a breaking change. */
export interface ImpactNotice {
  readonly tone: 'info' | 'warning';
  /** The version saving makes, which the footer names too. */
  readonly version: string;
  readonly lead: string;
  /** Empty for a compatible change. */
  readonly details: readonly string[];
}

/** One breaking change in words. */
export function describeBreakingChange(change: WorkflowImpactChange): string {
  const step = 'step' in change ? change.step : 0;
  switch (change.kind) {
    case 'step-signal':
      return copy.changes.stepSignal(step, change.from, change.to);
    case 'step-removed':
      return copy.changes.stepRemoved(step);
    case 'step-replaced':
      return copy.changes.stepReplaced(step);
    case 'step-input':
      return copy.changes.stepInput(step);
    case 'input-schema':
      return copy.changes.inputSchema;
    case 'output-schema':
      return copy.changes.outputSchema;
    default:
      return copy.changes.other;
  }
}

/** What happens to the runs in flight under a breaking change. */
function inFlightSentence(impact: WorkflowImpact): string {
  if (impact.inFlight === null) return copy.unknownInFlight;
  if (impact.inFlight === 0) return copy.noneInFlight;
  return copy.inFlight(impact.inFlight, impact.previousVersion);
}

/** The notice for an answer of `bureau.workflows.impact`, or `undefined` when no version is made. */
export function impactNotice(impact: WorkflowImpact): ImpactNotice | undefined {
  const version = impact.version;
  if (version === null) return undefined;
  if (impact.compatibility === 'breaking') {
    return {
      tone: 'warning',
      version,
      lead: copy.breaking(version),
      details: [
        ...impact.changes.filter((change) => change.breaking).map(describeBreakingChange),
        inFlightSentence(impact),
        copy.laterRuns(version),
        copy.renameNote,
      ],
    };
  }
  return {
    tone: 'info',
    version,
    lead: impact.previousVersion === null ? copy.first(version) : copy.compatible(version),
    details: [],
  };
}

/** The recorded changes on a saved version, in the words used on its History row. */
export function savedChangeSummary(revision: SavedWorkflowVersion): string | undefined {
  const history = WORKFLOW_COPY.revisions;
  if (revision.changes.length === 0) return undefined;
  const changes = new Set(
    revision.changes.map((change) => {
      if (change.breaking) return describeBreakingChange(change);
      switch (change.kind) {
        case 'step-added': {
          const step = revision.steps[change.step - 1];
          return step?.['kind'] === 'await-signal' && step['review'] === true
            ? history.addedApproval
            : history.addedStep(change.step);
        }
        case 'step-reworded':
          return history.rewordedStep(change.step);
        case 'step-renamed':
          return history.renamedStep(change.step);
        default:
          return 'step' in change ? history.changedStep(change.step) : history.changedFile;
      }
    }),
  );
  const summary = [...changes].join(', ');
  return revision.surface === 'web' ? history.editedInBuilder(summary) : summary;
}
