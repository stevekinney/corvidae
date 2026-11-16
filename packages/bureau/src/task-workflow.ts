/**
 * The workflow a task ran on (COR-2423): the type the engine ran it as, which schedule it belongs
 * to, what a schedule tick recorded, and how far an instance of a workflow file got. A task view
 * carries it so a list of runs can name each run by what it is, filter by it, and say "failed at
 * step 2 of 4" or "waiting for signal notes-approved", without reading the engine run by run.
 *
 * Every task has one. A task recorded before the type was kept reads the type its origin implies
 * ({@link workflowTypeOfRecord}): an attempt of a goal is the goal workflow, a run the Bureau
 * started for its own bookkeeping is the schedule tick, and everything else (a chat's run, a
 * schedule's fire, a child run, a step of a workflow instance) is an agent run. A run the Bureau
 * records from the engine, a schedule tick or an instance of a workflow file, keeps its own.
 *
 * @module task-workflow
 */

import { RUN_ENGINE_WORKFLOW_TYPE } from '@lostgradient/operative';

import type { StoredTaskOrigin } from './task-origin';

/** What a schedule tick recorded, kept on the tick's task (COR-2009). */
export interface TaskTick {
  /** `came-due`: an agent schedule's fire started. `missed-runs`: the engine noticed missed fires. */
  readonly event: 'came-due' | 'missed-runs';
  /** How many fires were missed, for `missed-runs`; `null` for `came-due`. */
  readonly missedRuns: number | null;
  /** Whether the missed window began before this Bureau started (the catch-up after the host was off). */
  readonly whileStopped: boolean;
}

/** How far an instance of a workflow file got. */
export interface TaskSteps {
  /** How many steps the instance's workflow has. */
  readonly total: number;
  /**
   * The step the instance is at, failed at, or finished on, counted from one among `total`:
   * `null` when it has not reached a step.
   */
  readonly at: number | null;
}

/** The workflow a task ran on, as its view shows it. */
export interface TaskWorkflow {
  /**
   * The engine workflow type: `agentRun`, `goalRun`, `scheduleTick`, or the identifier of a
   * workflow file for one of its instances.
   */
  readonly type: string;
  /** The schedule the run belongs to (a fire's, an instance's, or the one a tick records), or `null`. */
  readonly scheduleId: string | null;
  /** The schedule's name when a tick recorded it, or `null`. */
  readonly scheduleName: string | null;
  /** What a schedule tick recorded, or `null` for any other run. */
  readonly tick: TaskTick | null;
  /** How far an instance of a workflow file got, or `null` for any other run. */
  readonly steps: TaskSteps | null;
  /** The signal an instance waits for at an `await-signal` step, or `null`. */
  readonly awaitingSignal: string | null;
}

/** What a task record keeps of its workflow: the type, and what the engine run told the Bureau. */
export interface StoredTaskWorkflow {
  readonly type: string;
  readonly scheduleId?: string | undefined;
  readonly scheduleName?: string | undefined;
  readonly tick?: TaskTick | undefined;
  readonly stepsTotal?: number | undefined;
  readonly stepAt?: number | undefined;
  readonly awaitingSignal?: string | undefined;
}

/** The type of the schedule tick workflow, which the Bureau starts for its own bookkeeping. */
export const SCHEDULE_TICK_TASK_WORKFLOW_TYPE = RUN_ENGINE_WORKFLOW_TYPE.scheduleTick;

/** The workflow type of a task recorded without one, read from where it came from. */
export function workflowTypeOfOrigin(origin: StoredTaskOrigin | undefined): string {
  switch (origin?.kind) {
    case 'goal':
      return RUN_ENGINE_WORKFLOW_TYPE.goalRun;
    case 'system':
      return SCHEDULE_TICK_TASK_WORKFLOW_TYPE;
    default:
      return RUN_ENGINE_WORKFLOW_TYPE.agentRun;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalCount(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  );
}

function isTaskTick(value: unknown): value is TaskTick {
  return (
    isRecord(value) &&
    (value['event'] === 'came-due' || value['event'] === 'missed-runs') &&
    (value['missedRuns'] === null || isOptionalCount(value['missedRuns'])) &&
    typeof value['whileStopped'] === 'boolean'
  );
}

/** Whether a stored value is a workflow a task record can keep, in every field a reader depends on. */
export function isStoredTaskWorkflow(value: unknown): value is StoredTaskWorkflow {
  return (
    isRecord(value) &&
    typeof value['type'] === 'string' &&
    value['type'] !== '' &&
    isOptionalString(value['scheduleId']) &&
    isOptionalString(value['scheduleName']) &&
    (value['tick'] === undefined || isTaskTick(value['tick'])) &&
    isOptionalCount(value['stepsTotal']) &&
    isOptionalCount(value['stepAt']) &&
    isOptionalString(value['awaitingSignal'])
  );
}

/** The schedule an origin names, when it is one. */
function scheduleIdOfOrigin(origin: StoredTaskOrigin | undefined): string | null {
  if (origin?.kind !== 'schedule') return null;
  const scheduleId: unknown = origin['scheduleId'];
  return typeof scheduleId === 'string' && scheduleId !== '' ? scheduleId : null;
}

/**
 * The workflow a task record shows: what it kept, with the type and the schedule read from its
 * origin where it kept none. A task's `awaitingSignal` and step show only while it has not ended,
 * since a settled run waits for nothing; its step stays, because it says where a run failed.
 */
export function workflowViewOf(
  record: {
    readonly origin?: StoredTaskOrigin | undefined;
    readonly workflow?: StoredTaskWorkflow | undefined;
  },
  settled: boolean,
): TaskWorkflow {
  const stored = record.workflow;
  return {
    type: stored?.type ?? workflowTypeOfOrigin(record.origin),
    scheduleId: stored?.scheduleId ?? scheduleIdOfOrigin(record.origin),
    scheduleName: stored?.scheduleName ?? null,
    tick: stored?.tick === undefined ? null : { ...stored.tick },
    steps:
      stored?.stepsTotal === undefined
        ? null
        : { total: stored.stepsTotal, at: stored.stepAt ?? null },
    awaitingSignal: settled ? null : (stored?.awaitingSignal ?? null),
  };
}
