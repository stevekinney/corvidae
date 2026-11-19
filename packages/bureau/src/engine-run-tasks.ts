/**
 * The engine's own runs, listed as tasks (COR-2423): the schedule tick the Bureau starts to record
 * what its scheduler did, and the instances of workflow files and of plugins' code workflows. Neither
 * is a run of an agent, so neither has a task record, but a list of what ran should show them beside
 * the runs they started: "Schedule tick, logged 4 missed runs", "Release notes, failed at step 2 of
 * 4", "waiting for signal notes-approved".
 *
 * Nothing is recorded for them. The engine is the one account of such a run, so a view is built from
 * the engine when the list is read: its status, its times, what started it, the schedule it belongs
 * to, how far it got and what it waits for. A run the engine has purged is no longer listed, and a
 * run's status can never disagree with the engine's, because it is the engine's.
 *
 * These views are read-only and listed only. `bureau.tasks.get`, `respond`, `cancel` and the task
 * event stream answer for a task record, so they do not reach one (an instance is read, cancelled and
 * observed through `bureau.workflows.runs.*`), and an A2A listing, which names tasks a peer may
 * address, never holds one.
 *
 * @module engine-run-tasks
 */

import type { RegistryAgnosticEngine, WorkflowState, WorkflowSummary } from '@lostgradient/weft';
import {
  RUN_ENGINE_WORKFLOW_TYPE,
  isScheduleTick,
  type ScheduleTick,
} from '@lostgradient/operative';

import type { TaskState, TaskView } from './task-registry';
import { isTaskOrigin, type TaskOrigin } from './task-origin';
import type { TaskWorkflow } from './task-workflow';
import { bureauNameOf, weftNameOf } from './namespaced-identifier';
import { workflowFileStepsInCanonicalOrder, type WorkflowFileStep } from './workflow-file';

/** The newest runs of one workflow type read for a listing, so a long history cannot make it unbounded. */
export const ENGINE_RUN_TASKS_PER_TYPE = 100;

/** How many of the newest unfinished or failed instances have their history read for the step they reached. */
export const ENGINE_RUN_TASK_STEP_READS = 40;

/** The longest status message a view carries, as a task's own failure message is bounded. */
const STATUS_MESSAGE_LIMIT = 1000;

/** The engine, as far as this module reads it. */
export type EngineRunTaskEngine = Pick<RegistryAgnosticEngine, 'list' | 'get' | 'getEvents'>;

/** What {@link createEngineRunTasks} reads from the Bureau around it. */
export interface EngineRunTasksDependencies {
  /** The durable engine, or `undefined` for a Bureau without one, which has none of these runs. */
  readonly engine: () => EngineRunTaskEngine | undefined;
  /** The identifiers of every workflow file and code workflow whose instances are listed. */
  readonly workflowTypes: () => Promise<readonly string[]>;
  /**
   * The steps as written of the revision an instance of engine type `type` runs on, or `undefined`
   * when it is unknown. Their count is how many steps the workflow has.
   */
  readonly revisionSteps: (
    type: string,
    workflowVersion: string,
  ) => Promise<{ readonly steps: readonly WorkflowFileStep[] } | undefined>;
  /** Who owns an instance: the person who started it, else the deployment's owner. */
  readonly ownerOfInstance: (runId: string) => Promise<string | undefined>;
  /** Who owns a schedule, or `undefined` when it is unknown. */
  readonly ownerOfSchedule: (scheduleId: string) => Promise<string | undefined>;
  /** The owner a tick falls back to when its schedule has none: the deployment's. */
  readonly deploymentOwner: () => string;
  readonly diagnose: (message: string, cause: unknown) => void;
}

/** The workflow runtime, as far as {@link createEngineRunTasksOf} reads it. */
export interface EngineRunTasksRuntime {
  readonly workflowTypes: () => Promise<readonly string[]>;
  readonly revisionSteps: EngineRunTasksDependencies['revisionSteps'];
  readonly workflows: { readonly owner: string };
}

/**
 * {@link createEngineRunTasks} over the Bureau's workflow runtime and durable engine, each read when
 * a list is built: a Bureau with no workflow runtime lists no instance, and one with no durable
 * engine lists none at all.
 */
export function createEngineRunTasksOf(dependencies: {
  readonly runtime: () => EngineRunTasksRuntime | undefined;
  readonly engine: () => EngineRunTaskEngine | undefined;
  readonly ownerOfInstance: EngineRunTasksDependencies['ownerOfInstance'];
  readonly ownerOfSchedule: EngineRunTasksDependencies['ownerOfSchedule'];
  readonly localOwner: string;
  readonly diagnose: EngineRunTasksDependencies['diagnose'];
}): EngineRunTasks {
  return createEngineRunTasks({
    engine: () => (dependencies.runtime() === undefined ? undefined : dependencies.engine()),
    workflowTypes: async () => (await dependencies.runtime()?.workflowTypes()) ?? [],
    revisionSteps: async (type, workflowVersion) =>
      dependencies.runtime()?.revisionSteps(type, workflowVersion),
    ownerOfInstance: dependencies.ownerOfInstance,
    ownerOfSchedule: dependencies.ownerOfSchedule,
    deploymentOwner: () => dependencies.runtime()?.workflows.owner ?? dependencies.localOwner,
    diagnose: dependencies.diagnose,
  });
}

/** The engine's runs as task views. */
export interface EngineRunTasks {
  /** The newest runs, as task views with no open waits (the registry adds the reviews it holds). */
  readonly list: () => Promise<readonly TaskView[]>;
  /** Whether the engine still holds `runId` as a run this module lists. */
  readonly holds: (runId: string) => Promise<boolean>;
}

const STATE_OF_STATUS = {
  pending: 'submitted',
  running: 'working',
  suspended: 'working',
  completed: 'completed',
  failed: 'failed',
  'timed-out': 'failed',
  cancelled: 'canceled',
} as const satisfies Record<WorkflowSummary['status'], TaskState>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncated(text: string): string {
  return text.length <= STATUS_MESSAGE_LIMIT ? text : text.slice(0, STATUS_MESSAGE_LIMIT);
}

/**
 * The schedule an instance was started by and the origin it records, read from its input. An
 * instance a person or a plugin started carries an `origin`; one a schedule fired carries the
 * schedule's trigger (`{ kind: 'schedule', scheduleId }`) and no origin.
 */
export function instanceStartOf(
  input: unknown,
  runId: string,
): {
  readonly origin: TaskOrigin | null;
  readonly scheduleId: string | null;
} {
  if (!isRecord(input)) return { origin: null, scheduleId: null };
  const recorded: unknown = input['origin'];
  const origin = isTaskOrigin(recorded) ? recorded : null;
  if (origin?.kind === 'schedule') return { origin, scheduleId: origin.scheduleId };
  const scheduleId = input['kind'] === 'schedule' ? input['scheduleId'] : undefined;
  if (typeof scheduleId === 'string' && scheduleId !== '') {
    // The fire is the run the schedule started: this instance.
    return { origin: origin ?? { kind: 'schedule', scheduleId, fireId: runId }, scheduleId };
  }
  return { origin, scheduleId: null };
}

/** How far an instance got, from the step its history last started. */
function stepOf(events: readonly { type: string; data: Record<string, unknown> }[]): number | null {
  const started = events.findLast((event) => event.type === 'file-workflow:step-started');
  const index = started?.data['step'];
  return typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? index + 1 : null;
}

/** Builds the engine's runs as tasks. */
export function createEngineRunTasks(dependencies: EngineRunTasksDependencies): EngineRunTasks {
  const { diagnose } = dependencies;

  async function owned(run: WorkflowSummary, state: WorkflowState): Promise<string> {
    if (run.type === RUN_ENGINE_WORKFLOW_TYPE.scheduleTick) {
      const tick: unknown = state.input;
      const scheduleId = isScheduleTick(tick) ? tick.scheduleId : undefined;
      const owner =
        scheduleId === undefined ? undefined : await dependencies.ownerOfSchedule(scheduleId);
      return owner ?? dependencies.deploymentOwner();
    }
    return (await dependencies.ownerOfInstance(run.id)) ?? dependencies.deploymentOwner();
  }

  async function tickView(run: WorkflowSummary, state: WorkflowState): Promise<TaskView> {
    const input: unknown = state.input;
    const tick: ScheduleTick | undefined = isScheduleTick(input) ? input : undefined;
    const workflow: TaskWorkflow = {
      type: RUN_ENGINE_WORKFLOW_TYPE.scheduleTick,
      scheduleId: tick?.scheduleId ?? null,
      scheduleName: tick?.scheduleName ?? null,
      tick:
        tick === undefined
          ? null
          : {
              event: tick.event,
              missedRuns: tick.event === 'missed-runs' ? tick.missedRuns : null,
              whileStopped: tick.event === 'missed-runs' ? tick.whileStopped : false,
            },
      steps: null,
      awaitingSignal: null,
    };
    return viewOf(run, state, await owned(run, state), { kind: 'system' }, workflow);
  }

  function viewOf(
    run: WorkflowSummary,
    state: WorkflowState,
    owner: string,
    origin: TaskOrigin | null,
    workflow: TaskWorkflow,
  ): TaskView {
    const status = STATE_OF_STATUS[state.status];
    return {
      id: run.id,
      // A run of the engine's own has no session: its handle is its context, as a catalog run's.
      contextId: run.id,
      agentName: null,
      owner,
      actor: null,
      kind: 'catalog',
      origin,
      status,
      finishReason:
        status === 'failed' ? (state.status === 'timed-out' ? 'timed-out' : 'error') : null,
      statusMessage:
        status === 'failed'
          ? truncated(
              state.error ??
                (state.status === 'timed-out' ? 'The run timed out.' : 'The run failed.'),
            )
          : null,
      createdAt: new Date(state.createdAt).toISOString(),
      updatedAt: new Date(state.updatedAt).toISOString(),
      cleanup: null,
      openWaits: [],
      wakeAt: null,
      workflow,
      usage: null,
    };
  }

  async function instanceView(
    run: WorkflowSummary,
    state: WorkflowState,
    engine: EngineRunTaskEngine,
    readSteps: boolean,
  ): Promise<TaskView> {
    const { origin, scheduleId } = instanceStartOf(state.input, run.id);
    const revision = await dependencies.revisionSteps(run.type, state.versionTuple.workflowVersion);
    const total =
      revision === undefined ? undefined : workflowFileStepsInCanonicalOrder(revision.steps).length;
    const finished = state.status === 'completed';
    const reached =
      total === undefined
        ? null
        : finished
          ? total
          : readSteps
            ? stepOf(await engine.getEvents(run.id))
            : null;
    // The engine reports a wait on a signal while the run is `running` as well as `suspended`.
    const unfinished = ['pending', 'running', 'suspended'].includes(state.status);
    const waiting = unfinished ? (state.waitingForSignals?.[0] ?? null) : null;
    const workflow: TaskWorkflow = {
      type: bureauNameOf(run.type),
      scheduleId,
      scheduleName: null,
      tick: null,
      steps: total === undefined ? null : { total, at: reached },
      awaitingSignal: waiting,
    };
    return viewOf(run, state, await owned(run, state), origin, workflow);
  }

  return {
    async list() {
      const engine = dependencies.engine();
      if (engine === undefined) return [];
      // A read the engine refuses leaves those runs out and is reported, never a failure of the
      // list of the tasks that have records (the way `runCounts` leaves a count out).
      const types: string[] = [RUN_ENGINE_WORKFLOW_TYPE.scheduleTick];
      try {
        const identifiers = await dependencies.workflowTypes();
        types.push(...identifiers.map((type) => weftNameOf(type)));
      } catch (error) {
        diagnose('Could not read the workflow types to list their instances as tasks.', error);
      }
      const found: WorkflowSummary[] = [];
      for (const type of new Set(types)) {
        try {
          const page = await engine.list({ type, limit: ENGINE_RUN_TASKS_PER_TYPE });
          found.push(...page.items);
        } catch (error) {
          diagnose(`Could not list the runs of "${type}" as tasks.`, error);
        }
      }
      // Newest first, so the history a few runs are read for is the newest's.
      const newest = found.toSorted(
        (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
      );
      let stepReads = 0;
      const views: TaskView[] = [];
      for (const run of newest) {
        try {
          const state = await engine.get(run.id);
          if (state === null || state === undefined) continue;
          if (run.type === RUN_ENGINE_WORKFLOW_TYPE.scheduleTick) {
            views.push(await tickView(run, state));
            continue;
          }
          const needsHistory =
            state.status !== 'completed' && stepReads < ENGINE_RUN_TASK_STEP_READS;
          if (needsHistory) stepReads += 1;
          views.push(await instanceView(run, state, engine, needsHistory));
        } catch (error) {
          // One run the engine cannot read is left out, never a failure of the whole list.
          diagnose(`Could not list the engine run "${run.id}" as a task.`, error);
        }
      }
      return views;
    },

    async holds(runId) {
      const engine = dependencies.engine();
      if (engine === undefined) return false;
      try {
        const state = await engine.get(runId);
        if (state === null || state === undefined) return false;
        if (state.type === RUN_ENGINE_WORKFLOW_TYPE.scheduleTick) return true;
        const identifiers = await dependencies.workflowTypes();
        return identifiers.some((type) => weftNameOf(type) === state.type);
      } catch (error) {
        diagnose(`Could not tell whether the engine still holds "${runId}".`, error);
        return false;
      }
    },
  };
}
