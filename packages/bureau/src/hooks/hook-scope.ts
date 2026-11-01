/**
 * What a hook's scope matches (COR-1978): the subjects an event is about, read from the event itself
 * and from the Bureau's own records of the run, schedule or goal it names. The scope on the hook is
 * only ever compared to that answer: nothing a client sent decides whether an event is in scope.
 *
 * ## What an event is about
 *
 * - An **agent**: the `agentName` of the payload, else the agent of the run it names, of the schedule
 *   it names, or of the goal it names. A run's agent is its own: a child run of another agent, or a
 *   step of a workflow, belongs to the agent that ran it, never to the run above it.
 * - A **workflow**: the workflow file the run it names belongs to, through every run above it, or
 *   the file whose schedule it names. A step's review is a review of that workflow.
 * - A **schedule**: the schedule it names, or the one that fired the run it names, through every run
 *   above it.
 *
 * `BureauEventCatalogEntry.scopes` says which of these each kind can answer, and a hook cannot list
 * a kind its scope does not fit, so a scope that matches nothing is a subject that has not happened.
 *
 * ## When it cannot tell
 *
 * A scoped hook does not fire. A lookup that fails is reported, and the event is out of scope for
 * every scoped hook, because a hook fires only for its subject; an unscoped hook is not affected. A
 * record whose scope this release cannot read matches nothing, for the same reason.
 *
 * @module hook-scope
 */

import { parseWorkflowScheduleId } from '../workflow-schedule.ts';
import { HOOK_SCOPE_KINDS, type HookScope, type HookScopeKind } from './hook-types.ts';

/** The subjects of a run, as {@link HookSubjectSources.run} reads them. */
export interface HookRunSubjects {
  /** The agent the run itself ran, when it ran one. */
  readonly agent: string | undefined;
  /** The workflows the run belongs to, itself and every run above it. */
  readonly workflows: readonly string[];
  /** The schedules that fired the run or a run above it. */
  readonly schedules: readonly string[];
}

/** The records a scope is matched against. Any of them may throw; the event is then out of scope. */
export interface HookSubjectSources {
  /** What the Bureau holds about the run `runId`. */
  run(runId: string): Promise<HookRunSubjects>;
  /** The agent the schedule `scheduleId` runs, or `undefined` when it runs none. */
  agentOfSchedule(scheduleId: string): Promise<string | undefined>;
  /** The agent the goal `goalRunId` is pursued by, or `undefined` when there is no such goal. */
  agentOfGoal(goalRunId: string): Promise<string | undefined>;
}

/** The subjects of one event, by kind. */
export type HookEventSubjects = Readonly<Record<HookScopeKind, ReadonlySet<string>>>;

/** The string in `payload` at `field`, or `undefined`. A payload is a plain record, but its keys are not ours. */
function stringField(
  payload: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = Object.hasOwn(payload, field) ? payload[field] : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Reads the subjects of the event `payload` belongs to. Throws when a source does. */
export async function subjectsOfPayload(
  payload: Readonly<Record<string, unknown>>,
  sources: HookSubjectSources,
): Promise<HookEventSubjects> {
  const agents = new Set<string>();
  const workflows = new Set<string>();
  const schedules = new Set<string>();

  const named = stringField(payload, 'agentName');
  if (named !== undefined) agents.add(named);

  const scheduleId = stringField(payload, 'scheduleId');
  if (scheduleId !== undefined) {
    schedules.add(scheduleId);
    const workflow = parseWorkflowScheduleId(scheduleId);
    if (workflow !== undefined) workflows.add(workflow.identifier);
    else if (named === undefined) {
      const agent = await sources.agentOfSchedule(scheduleId);
      if (agent !== undefined) agents.add(agent);
    }
  }

  const runId = stringField(payload, 'runId') ?? stringField(payload, 'taskId');
  if (runId !== undefined) {
    const run = await sources.run(runId);
    if (named === undefined && run.agent !== undefined) agents.add(run.agent);
    for (const workflow of run.workflows) workflows.add(workflow);
    for (const schedule of run.schedules) schedules.add(schedule);
  }

  const goalRunId = stringField(payload, 'goalRunId');
  if (goalRunId !== undefined) {
    const agent = await sources.agentOfGoal(goalRunId);
    if (agent !== undefined) agents.add(agent);
  }

  return { agent: agents, workflow: workflows, schedule: schedules };
}

function isScopeKind(kind: string): kind is HookScopeKind {
  return (HOOK_SCOPE_KINDS as readonly string[]).includes(kind);
}

/** Whether an event with `subjects` is the one `scope` names. A kind this release does not know never is. */
export function scopeMatches(scope: HookScope, subjects: HookEventSubjects): boolean {
  return isScopeKind(scope.kind) && subjects[scope.kind].has(scope.id);
}
