/**
 * What the run page says of an instance of a workflow file, read from the history the Bureau keeps
 * of it (`bureau.workflows.runs.history`) and the steps of the version it ran (`bureau.workflows.
 * revisions`): how far it got ("at step 2 of 4"), which step failed and what that step is called,
 * how many times it was tried, and whether the version it ran is the workflow's current one
 * (COR-2424, rows 54l, 54y, 14t, 55b, 55d).
 *
 * Pure, so each rule is a table test and the page only hands it what it has read.
 */
import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
import type { WorkflowRunHistoryEvent } from '../../../lib/workflow-files.ts';
import { stepLabel } from '../../workflow-definitions/workflow-presentation.ts';

/** One step as a workflow file writes it. */
export type InstanceStep = Readonly<Record<string, unknown>>;

/**
 * The step an instance's history last started, counted from one, or `null` when it has not started
 * one. The history names a step by its index from zero.
 */
export function stepReached(events: readonly WorkflowRunHistoryEvent[]): number | null {
  const started = events.findLast((event) => event.type === 'file-workflow:step-started');
  if (started === undefined || started.step === null) return null;
  const index = Number(started.step);
  return Number.isSafeInteger(index) && index >= 0 ? index + 1 : null;
}

/**
 * How many times the activity of step `at` (counted from one) was started: each start is one try.
 * A step with no activity (a sleep, an awaited signal) has none.
 */
export function triesAtStep(events: readonly WorkflowRunHistoryEvent[], at: number): number {
  const step = String(at - 1);
  return events.filter(
    (event) => event.type === 'file-workflow:activity-started' && event.step === step,
  ).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The steps of a workflow file in the order the engine counts them: preorder, a `map`'s steps, a
 * `parallel`'s branches and a `branch`'s cases after their wrapper (the cases and branches in
 * sorted order, then `otherwise`). The history names a step by this index, and the Bureau counts a
 * run's steps by it (`workflowFileStepsInCanonicalOrder`), so the page counts the same way: a
 * nested step is a step, and the count of "step 2 of 4" is the Bureau's.
 */
export function canonicalSteps(steps: readonly InstanceStep[]): InstanceStep[] {
  const ordered: InstanceStep[] = [];
  const visit = (nested: readonly InstanceStep[]): void => {
    for (const step of nested) {
      ordered.push(step);
      if (!isRecord(step)) continue;
      if (step['kind'] === 'map' && Array.isArray(step['steps'])) {
        visit(step['steps'] as InstanceStep[]);
        continue;
      }
      const branches = step['branches'];
      if (step['kind'] === 'parallel' && isRecord(branches)) {
        for (const name of Object.keys(branches).toSorted()) {
          const branch = branches[name];
          if (Array.isArray(branch)) visit(branch as InstanceStep[]);
        }
        continue;
      }
      const cases = step['cases'];
      if (step['kind'] !== 'branch' || !isRecord(cases)) continue;
      for (const literal of Object.keys(cases).toSorted()) {
        const branch = cases[literal];
        if (Array.isArray(branch)) visit(branch as InstanceStep[]);
      }
      const otherwise = step['otherwise'];
      if (Array.isArray(otherwise)) visit(otherwise as InstanceStep[]);
    }
  };
  visit(steps);
  return ordered;
}

/** What step `at` (counted from one, in the engine's order) is called: its title, else what it does in words. */
export function instanceStepName(steps: readonly InstanceStep[], at: number): string | undefined {
  const step = canonicalSteps(steps)[at - 1];
  if (step === undefined) return undefined;
  const title: unknown = step['title'];
  if (typeof title === 'string' && title.trim() !== '') return title.trim();
  const kind: unknown = step['kind'];
  return typeof kind === 'string' ? stepLabel({ ...step, kind }) : undefined;
}

/** How far an instance got, and the step it was at. */
export type InstanceProgress = {
  /** The step the run is at, failed at or finished on, counted from one. */
  readonly at: number | null;
  /** How many steps the version the run ran has, when that is known. */
  readonly total: number | null;
  /** What that step is called, when the version's steps are known. */
  readonly name: string | undefined;
  /** How many times that step's activity was started. */
  readonly tries: number;
};

/** The progress of an instance from its history and the steps of the version it ran. */
export function instanceProgress(
  events: readonly WorkflowRunHistoryEvent[],
  steps: readonly InstanceStep[] | undefined,
): InstanceProgress {
  const at = stepReached(events);
  return {
    at,
    total: steps === undefined ? null : canonicalSteps(steps).length,
    name: at === null || steps === undefined ? undefined : instanceStepName(steps, at),
    tries: at === null ? 0 : triesAtStep(events, at),
  };
}

/** The part of the status line that says how far the run got: "step 2 of 4", or "at step 2 of 4". */
export function progressPhrase(progress: InstanceProgress, failed: boolean): string | undefined {
  if (progress.at === null || progress.total === null) return undefined;
  const copy = RUN_DETAIL_COPY.instance;
  return failed
    ? copy.failedAt(progress.at, progress.total)
    : copy.stepOf(progress.at, progress.total);
}

/** The words of the block on the failing step: "Step 2, Collect merged changes, failed after 2 tries". */
export function failureHeading(progress: InstanceProgress): string | undefined {
  if (progress.at === null) return undefined;
  const copy = RUN_DETAIL_COPY.instance;
  return copy.failureHeading(progress.at, progress.name, progress.tries);
}

/** One entry of what happened in an instance: the run started, a step began, or the run ended. */
export type InstanceEntry = {
  readonly key: string;
  readonly title: string;
  /** How long after the run started the entry happened, in milliseconds. */
  readonly offsetMilliseconds?: number | undefined;
  readonly state: 'done' | 'current' | 'failed';
};

/**
 * What happened in an instance, in order: when it started, then each step it began with how long
 * after the start, the last of them failed when the run failed or current while the run goes on.
 */
export function instanceEntries(input: {
  readonly events: readonly WorkflowRunHistoryEvent[];
  readonly steps: readonly InstanceStep[] | undefined;
  readonly startedAt: number;
  readonly status: 'running' | 'failed' | 'over';
}): InstanceEntry[] {
  const copy = RUN_DETAIL_COPY.instance;
  const seen = new Set<number>();
  const begun: { at: number; offset: number | undefined }[] = [];
  for (const event of input.events) {
    if (event.type !== 'file-workflow:step-started' || event.step === null) continue;
    const index = Number(event.step);
    if (!Number.isSafeInteger(index) || index < 0 || seen.has(index)) continue;
    seen.add(index);
    const at = Date.parse(event.timestamp);
    begun.push({
      at: index + 1,
      offset: Number.isFinite(at) ? Math.max(0, at - input.startedAt) : undefined,
    });
  }
  return begun.map((step, position) => {
    const last = position === begun.length - 1;
    const name = input.steps === undefined ? undefined : instanceStepName(input.steps, step.at);
    return {
      key: `step-${String(step.at)}`,
      title: copy.stepEntry(step.at, name),
      offsetMilliseconds: step.offset,
      state:
        last && input.status === 'failed'
          ? 'failed'
          : last && input.status === 'running'
            ? 'current'
            : 'done',
    };
  });
}

/** Where the version a run ran stands against the workflow's current one. */
export type VersionStanding = {
  readonly state: 'current' | 'older' | 'unknown';
  /** The version the run ran, as the engine recorded it. */
  readonly ran: string;
  /** The workflow's current version, when it has one. */
  readonly current: string | null;
};

/** Whether `ran` is the workflow's `current` version, an older one, or cannot be told. */
export function versionStanding(ran: string, current: string | null): VersionStanding {
  if (current === null || current === '') return { state: 'unknown', ran, current: null };
  return { state: ran === current ? 'current' : 'older', ran, current };
}
