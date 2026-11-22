/**
 * Reading what Bureau stored about one failed run and explaining it (COR-2532, COR-2543): the one
 * path `bureau.tasks.explain` and the `tasks-explain` agent tool both take, so the operation, the
 * tool, the Run page, the CLI and the failure explanation panel give one answer. It is the part
 * after the caller has been let in to the run: who may read a run is the operation's and the
 * tool's own check, never decided here.
 *
 * @module run-failure-read
 */

import type { FailureCategory, WorkflowTimelineEntry } from '@lostgradient/weft';

import {
  classifyAgentRunFailure,
  explainRunFailure,
  type RunFailureExplanation,
  type RunFailureStep,
  type RunVerdict,
} from './run-failure-explanation.ts';
import { failedStepTries } from './run-timeline.ts';
import type { TaskView } from './task-registry.ts';

/** What the engine holds of a run that the explanation reads. */
interface RunFailureState {
  readonly status: string;
  readonly failureCategory?: FailureCategory | null | undefined;
  readonly errorCode?: string | undefined;
  readonly failedStep?: RunFailureStep | undefined;
}

/** What {@link readRunFailure} reads about a run, for a caller already let in to it. */
export interface RunFailureReads {
  /** The engine's state of the run, or `undefined` for a Bureau with no durable engine or no such run. */
  readonly runState: (runId: string) => Promise<RunFailureState | undefined>;
  /** The engine's timeline of the run, or `undefined` for a Bureau with no durable engine. */
  readonly runTimeline: (runId: string) => Promise<readonly WorkflowTimelineEntry[] | undefined>;
  /** The guardrails that fired in the run, read from the audit trail. */
  readonly runVerdicts: (
    runId: string,
    kind: 'agent' | 'workflow',
  ) => Promise<readonly RunVerdict[]>;
}

/** The run to explain: an agent run with its task, or an instance of a workflow file. */
export type RunToExplain =
  { readonly kind: 'agent'; readonly task: TaskView } | { readonly kind: 'workflow' };

/** The explanation as plain, mutable data: nothing of the stored facts is shared with the caller. */
export type PlainRunFailureExplanation = Omit<
  RunFailureExplanation,
  'verdicts' | 'nextCommands'
> & {
  verdicts: RunVerdict[];
  nextCommands: string[];
};

/**
 * What the read found: the explanation of a failed run, a run that did not fail (with the status it
 * has), or a workflow instance the Bureau cannot read because it has no durable engine.
 */
export type RunFailureRead =
  | { readonly outcome: 'explained'; readonly explanation: PlainRunFailureExplanation }
  | { readonly outcome: 'not-failed'; readonly status: string }
  | { readonly outcome: 'unsupported' };

/** An identifier a stored value may be answered as: letters, digits and a few separators. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/;

function identifierOrNull(value: string | null | undefined): string | null {
  return value !== undefined && value !== null && IDENTIFIER.test(value) ? value : null;
}

/**
 * The explanation of the run `runId`, from what is stored of it. `retryable` is asked only for a
 * failed workflow instance, and says whether a retry would run it again for the caller.
 */
export async function readRunFailure(
  reads: RunFailureReads,
  run: RunToExplain,
  runId: string,
  retryable: () => Promise<boolean>,
): Promise<RunFailureRead> {
  const state = await reads.runState(runId);

  let category: FailureCategory | null;
  let code: string | null;
  let errorKind: string | null;
  let step: RunFailureStep | null;
  if (run.kind === 'agent') {
    if (run.task.status !== 'failed') return { outcome: 'not-failed', status: run.task.status };
    const failure = run.task.failure;
    code = identifierOrNull(failure?.errorCode);
    errorKind = identifierOrNull(failure?.errorKind);
    // An agent run ends as a completed engine run that carries a failed result, so the engine
    // holds a category only for one it failed itself; the task's own finish reason says the rest.
    category =
      state?.failureCategory ??
      classifyAgentRunFailure({ finishReason: run.task.finishReason, errorKind });
    step = failure?.step ?? null;
  } else {
    // An instance exists only on a durable engine: no state to read is a Bureau that keeps none,
    // not a run that did not fail.
    if (state === undefined) return { outcome: 'unsupported' };
    if (state.status !== 'failed' && state.status !== 'timed-out') {
      return { outcome: 'not-failed', status: state.status };
    }
    category = state.failureCategory ?? (state.status === 'timed-out' ? 'timeout' : null);
    code = identifierOrNull(state.errorCode);
    errorKind = null;
    step = state.failedStep ?? null;
  }

  const entries = await reads.runTimeline(runId);
  // An agent run with no timeline keeps `tries: null`; a workflow instance has one or the Bureau
  // has no durable engine.
  if (entries === undefined && run.kind === 'workflow') return { outcome: 'unsupported' };
  const explanation = explainRunFailure({
    kind: run.kind,
    runId,
    category,
    code,
    errorKind,
    step: step === null ? null : { index: step.index, label: step.label },
    tries: entries === undefined ? null : failedStepTries(entries),
    verdicts: await reads.runVerdicts(runId, run.kind),
    retryable: run.kind === 'workflow' && (await retryable()),
  });
  // The answer is plain, mutable data: nothing of the stored facts is shared with the caller.
  return {
    outcome: 'explained',
    explanation: {
      ...explanation,
      verdicts: explanation.verdicts.map((verdict) => ({ ...verdict })),
      nextCommands: [...explanation.nextCommands],
    },
  };
}
