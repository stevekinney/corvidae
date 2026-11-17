/**
 * The runs of one workflow as the rows of `/runs` (`run-rows.ts`), so the workflow page's Runs tab
 * draws the Runs page's own row, segments and Started by filter (board PageWorkflow, "Runs tab").
 * `/runs` reads the Bureau's tasks, and no task names the workflow it belongs to, so the tab reads
 * the workflow's own instances instead: a file's from the Bureau (`bureau.workflows.runs.list`)
 * and a code type's from the engine. Each instance becomes one {@link RunRow}: titled with the
 * workflow's name, run by the workflow's agent, and started by what its recorded origin names.
 *
 * A file's instance summary says how far the run got, the signal it waits for and why it failed
 * (COR-2431), so line two reads as the Runs page's own: "Schedule, Release notes digest, Assistant,
 * failed at step 2 of 4, GitHub didn’t answer, 3 s". A code type's instances say none of them.
 */
import type { WorkflowStatus } from '@lostgradient/weft';

import type { TaskState } from '../../lib/bureau-tasks.ts';
import { chatSessionPath, goalPath } from '../../lib/identifier-paths.ts';
import { scheduleDetailPath, workflowDetailPath } from '../../lib/router.svelte.ts';
import type { WorkflowFileRun } from '../../lib/workflow-files.ts';
import {
  goalTitle,
  type RunOrigin,
  type RunRow,
  triggerOrigin,
} from '../workflows/runs/run-rows.ts';

/**
 * How an instance's status reads on the Runs list. One that has not started yet is Running to
 * whoever waits on it, as a submitted task is. A suspended instance is waiting at a step, so it is
 * counted under the Waiting segment, never under Running. One that timed out did not finish, so it
 * has Failed.
 */
const STATE_OF_STATUS: Readonly<Record<WorkflowStatus, TaskState>> = {
  pending: 'submitted',
  running: 'working',
  suspended: 'input-required',
  completed: 'completed',
  failed: 'failed',
  'timed-out': 'failed',
  cancelled: 'canceled',
};

/** The task state an instance's status reads as, on the Runs list's vocabulary. */
export function workflowRunState(status: WorkflowStatus): TaskState {
  return STATE_OF_STATUS[status];
}

/** What started an instance, as the Bureau recorded it on the instance, or `null` when it did not. */
export type WorkflowRunOrigin = NonNullable<WorkflowFileRun['origin']>;

/** What started an instance, in the words of a run's row. An instance with no recorded origin has none. */
export function workflowRunOrigin(origin: WorkflowRunOrigin | null | undefined): RunOrigin {
  if (origin === null || origin === undefined) return { kind: 'none' };
  switch (origin.kind) {
    case 'chat':
      return { kind: 'chat', title: '', href: chatSessionPath(origin.contextId) };
    case 'person':
      return { kind: 'person', surface: origin.surface };
    case 'schedule':
      return {
        kind: 'schedule',
        title: '',
        href: scheduleDetailPath(origin.scheduleId),
        scheduleId: origin.scheduleId,
        schedulePath: scheduleDetailPath(origin.scheduleId),
        manual: origin.manual === true,
      };
    case 'api':
      return { kind: 'api' };
    case 'agent':
      return {
        kind: 'agent',
        agentName: origin.agentName,
        parentRunId: origin.parentRunId,
        href: workflowDetailPath(origin.parentRunId),
      };
    case 'agent-run':
      return {
        kind: 'agent-run',
        agentName: origin.agentId,
        runId: origin.runId,
        href: workflowDetailPath(origin.runId),
      };
    case 'goal':
      return {
        kind: 'goal',
        name: origin.goalRunId,
        // The goal's name in words, never its identifier, as the Runs list says it.
        title: goalTitle(origin.goalRunId),
        href: goalPath(origin.goalRunId),
        session: null,
      };
    case 'parent':
      return {
        kind: 'parent',
        parentRunId: origin.parentRunId,
        href: workflowDetailPath(origin.parentRunId),
      };
    case 'system':
      return { kind: 'system' };
    case 'trigger':
      // The plugin and the file the origin names reach the row (COR-2171).
      return triggerOrigin(origin.plugin, origin.workflowId);
  }
}

/** One instance of a workflow, as the Runs tab reads it from either service. */
export type WorkflowRunSummary = {
  /** The instance's identifier. */
  readonly id: string;
  /** The instance's status, as the engine names it. */
  readonly status: WorkflowStatus;
  /** When the instance began, in epoch milliseconds. */
  readonly createdAt: number;
  /** When the instance last changed, in epoch milliseconds. */
  readonly updatedAt: number;
  /** What started it, when the Bureau recorded that; a code type's instances have none. */
  readonly origin: WorkflowRunOrigin | null;
  /**
   * COR-2431: how many steps its version has and the one it is at, failed at, or finished on (from
   * one), when the Bureau says; a code type's instances say none.
   */
  readonly steps?: { readonly total: number; readonly at: number | null } | null;
  /** The signal an unfinished instance waits for, when the Bureau says. */
  readonly awaitingSignal?: string | null;
  /** Why a failed instance ended, in the engine's words, when the Bureau says. */
  readonly failure?: string | null;
};

/** What every row of one workflow's runs shares: the workflow's name and the agent it runs. */
export type WorkflowRunRowContext = {
  /** The workflow's title, or its identifier when it has none: the title of every row. */
  readonly title: string;
  /** The agent the workflow runs, or `null` when it names none. */
  readonly agentName: string | null;
  /**
   * The workflow's identifier, which a row's line two reads as an instance of a workflow file's: it
   * names the schedule that fired it, how far it got, and what it waits for (COR-2431). Left out,
   * the row says none of them.
   */
  readonly type?: string;
  /** The name of each schedule that starts the workflow, by its identifier: line two names it. */
  readonly scheduleNames?: ReadonlyMap<string, string>;
};

/** Whether a task state is one a run cannot leave. */
function ended(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled';
}

/**
 * One instance of a workflow as a row of the Runs list. Its agent is the workflow's, except for an
 * instance an agent's tool call started, which names the agent that called it.
 */
export function workflowRunRow(run: WorkflowRunSummary, context: WorkflowRunRowContext): RunRow {
  const awaitingSignal = run.awaitingSignal ?? null;
  // An instance parked at a signal is Waiting (a hollow ring), never Waiting on you: it waits for a
  // signal, not for a person (row 63o). The Runs list reads such a run as going, with its signal.
  const status =
    awaitingSignal !== null && run.status === 'suspended'
      ? 'working'
      : workflowRunState(run.status);
  const origin = workflowRunOrigin(run.origin);
  const scheduleId = origin.kind === 'schedule' ? origin.scheduleId : null;
  const failure = status === 'failed' ? (run.failure ?? null) : null;
  return {
    id: run.id,
    agentName: run.origin?.kind === 'agent-run' ? run.origin.agentId : context.agentName,
    status,
    origin,
    title: context.title,
    // What a failed run said, which line two writes after the step it failed at.
    summary: failure ?? '',
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    durationMs: ended(status) ? Math.max(0, run.updatedAt - run.createdAt) : null,
    attempt: null,
    checkNotMet: false,
    ...(context.type === undefined
      ? {}
      : {
          workflowType: context.type,
          workflow: {
            type: context.type,
            scheduleId,
            scheduleName: null,
            tick: null,
            steps: run.steps ?? null,
            awaitingSignal,
          },
          scheduleName:
            scheduleId === null ? null : (context.scheduleNames?.get(scheduleId) ?? null),
        }),
  };
}

/** The instances of a workflow as the Runs list's rows, the most recently started first. */
export function workflowRunRows(
  runs: readonly WorkflowRunSummary[],
  context: WorkflowRunRowContext,
): RunRow[] {
  return runs
    .map((run) => workflowRunRow(run, context))
    .toSorted((left, right) => right.startedAt - left.startedAt || left.id.localeCompare(right.id));
}
