import type { HookPlanDescription } from '@lostgradient/lifecycle';
import {
  rebuildEffectiveContexts,
  type AgentRun,
  type RunEvent,
  type RunResult,
  type StepRecord,
} from '@lostgradient/operative';

import type { BureauChildren } from '../child-topology.ts';
import type { RunCreationReceipt } from '../command-ledger.ts';
import type { TaskRegistry } from '../task-registry.ts';
import { createTaskResponder, type TaskResponderDependencies } from './respond-to-task.ts';
import {
  INSPECTED_STEP_LIMIT,
  type BureauTasks,
  type TaskHandle,
  type TaskInput,
  type TaskInspection,
  type TaskInspectionFailedHook,
  type TaskInspectionHook,
} from '../bureau-types/tasks.ts';
import {
  type DurableEventHistoryRead,
  type DurableEventHistorySubscribe,
} from '../bureau-types/common.ts';

/**
 * What {@link createTasks} composes `bureau.tasks` from: the Bureau's own task implementations,
 * which share its run state, session store, durable engine, and command ledger and so are built
 * where that state lives, the task registry, the durable event history the run owner kind is read
 * from, and the child topology `inspect` reports.
 */
export type TasksDependencies = {
  readonly reservedStartsSupported?: boolean;
  readonly reserveStartClaim?: BureauTasks['reserveStartClaim'];
  /** {@link BureauTasks.start}. */
  readonly start: BureauTasks['start'];
  /** {@link BureauTasks.detail}. */
  readonly detail: BureauTasks['detail'];
  /** {@link BureauTasks.receipt}. */
  readonly receipt: BureauTasks['receipt'];
  /** {@link BureauTasks.workflow}. */
  readonly workflow: BureauTasks['workflow'];
  /** {@link BureauTasks.workflows}. */
  readonly workflows: BureauTasks['workflows'];
  /** {@link BureauTasks.wait}. */
  readonly wait: BureauTasks['wait'];
  /** {@link BureauTasks.snapshot}. */
  readonly snapshot: BureauTasks['snapshot'];
  /** The task registry `get`, `list`, `cancel`, and `inspect` read. */
  readonly registry: TaskRegistry;
  /** The child topology `inspect` lists a task's children from. */
  readonly children: Pick<BureauChildren<string>, 'list'>;
  /** The Bureau's durable event history read, which {@link BureauTasks.events} narrows to the run owner. */
  readonly eventHistory: DurableEventHistoryRead;
  /** The durable event history subscription, which {@link BureauTasks.subscribeEvents} narrows to the run owner. */
  readonly subscribeEventHistory: DurableEventHistorySubscribe;
  /** The run's step records from its checkpoint, oldest first; empty for a Bureau that keeps none. */
  readonly steps: (runId: string) => Promise<readonly StepRecord[]>;
  /**
   * The hook plan the run holds in this process, redacted, or `undefined` for a run this process
   * does not hold or whose plan cannot be read (COR-2115). `inspect` asks only for a run that is
   * still going.
   */
  readonly hookPlan: (runId: string) => HookPlanDescription | undefined;
  /** The registrations of the run's plan that threw, from the audit trail (COR-2115). */
  readonly failedHooks: (runId: string) => Promise<readonly TaskInspectionFailedHook[]>;
  /** The error a missing task is refused with. */
  readonly notFound: (message: string) => Error;
  /** The reviews, ledger, and refusals {@link BureauTasks.respond} answers with, over `registry`. */
  readonly responder: Omit<TaskResponderDependencies, 'registry'>;
};

/** The most registrations one inspection lists, so a plan that grows without bound stays a bounded answer. */
export const INSPECTED_HOOK_LIMIT = 500;

/** The text a registration's identity is cut to on the wire. */
const HOOK_TEXT_LIMIT = 256;

/**
 * The plan of a run that is still going, as the inspector lists it, or `null` for a run that has
 * ended and for a plan that cannot be read. A plan with no entries is an empty list: the run is
 * live and holds no hook.
 */
function livePlan(
  status: string,
  read: () => HookPlanDescription | undefined,
): readonly TaskInspectionHook[] | null {
  if (status === 'completed' || status === 'failed' || status === 'canceled') return null;
  let description: HookPlanDescription | undefined;
  try {
    description = read();
  } catch {
    return null;
  }
  if (description === undefined) return null;
  // Each entry is built field by field, so a field a plan entry gains reaches no client until it is
  // added here on purpose.
  return description.entries.slice(0, INSPECTED_HOOK_LIMIT).map((entry) => ({
    id: entry.id.slice(0, HOOK_TEXT_LIMIT),
    hookPoint: entry.hookName.slice(0, HOOK_TEXT_LIMIT),
    source: entry.source === undefined ? null : entry.source.slice(0, HOOK_TEXT_LIMIT),
    priority: Number.isFinite(entry.priority) ? entry.priority : 0,
    replay: entry.replay === 'safe' ? 'safe' : 'effectful',
  }));
}

/**
 * Build `bureau.tasks`. `start`, `detail`, `receipt`, the durable reads, and `snapshot` are the
 * Bureau's own; `get`, `list`, and `cancel` are the task registry's; `events` and
 * `subscribeEvents` read the durable event history for the `run` owner of the id; `inspect`
 * composes the registry's record, the run's liveness, and the task's children; `respond` answers
 * a task's open wait over the registry and the reviews, recording its receipts in its ledger.
 */
export function createTasks(dependencies: TasksDependencies): BureauTasks {
  const { registry } = dependencies;
  const responder = createTaskResponder({ ...dependencies.responder, registry });
  return {
    reservedStartsSupported: dependencies.reservedStartsSupported === true,
    reserveStartClaim:
      dependencies.reserveStartClaim ??
      (async () => {
        throw new Error('Reserved starts are unavailable');
      }),
    start: dependencies.start,
    detail: dependencies.detail,
    get: (id) => registry.get(id),
    list: (query) => registry.list(query),
    async cancel(id, options) {
      const outcome = await registry.cancel(id, options?.waitMilliseconds ?? 0);
      if (outcome === undefined) throw dependencies.notFound(`Task "${id}" not found`);
      return outcome;
    },
    receipt: dependencies.receipt,
    workflow: dependencies.workflow,
    workflows: dependencies.workflows,
    wait: dependencies.wait,
    snapshot: dependencies.snapshot,
    events: (id, options) => dependencies.eventHistory({ kind: 'run', id }, options),
    subscribeEvents: (id, listener, options) =>
      dependencies.subscribeEventHistory({ kind: 'run', id }, listener, options),
    async inspect(id, options): Promise<TaskInspection | undefined> {
      const task = await registry.get(id);
      if (task === undefined) return undefined;
      const children = await dependencies.children.list(id);
      const records = await dependencies.steps(id);
      const asked = options?.step;
      const wanted =
        asked === undefined
          ? records.slice(-INSPECTED_STEP_LIMIT)
          : records.filter((record) => record.step === asked);
      // The records store each step's effective context as a delta from the previous step's; one
      // step's whole record is rebuilt, and capped, only when that step is asked for.
      const rebuilt =
        asked === undefined
          ? []
          : rebuildEffectiveContexts(
              records.map((record) => record.effectiveContext),
              (index) => records[index]?.step === asked,
            );
      return {
        task,
        hooks: {
          plan: livePlan(task.status, () => dependencies.hookPlan(id)),
          failed: await dependencies.failedHooks(id),
        },
        liveness: dependencies.detail(id)?.liveness,
        children: children.map((child) => ({
          childRunId: child.childRunId,
          childAgentName: child.childAgentName,
          status: child.status,
          parentCancellation: child.parentCancellation,
          revision: child.revision,
          liveness: dependencies.detail(child.childRunId)?.liveness,
        })),
        // A record written before the reply details existed carries neither, and reads as `null`.
        // The effective context runs to 256 KiB a step, so the list form carries a marker and only
        // a read of one step carries the record.
        steps: wanted.map((record) => ({
          step: record.step,
          messageId: record.messageId ?? null,
          contextEpochId: record.contextEpochId ?? null,
          planReason: record.planReason ?? null,
          hasEffectiveContext: record.effectiveContext !== undefined,
          effectiveContext: rebuilt[records.indexOf(record)] ?? null,
        })),
      };
    },
    respond: (request) => responder.respond(request),
  };
}

/** What a {@link TaskHandle} is built from. */
export type TaskHandleSource<O> = {
  readonly id: string;
  readonly contextId: string;
  readonly receipt?: RunCreationReceipt | undefined;
  /**
   * The task's run in this process, when this process runs it, with an iterator over its events
   * opened when the run was created (a fresh start) or when the handle was (a replay).
   */
  readonly live?:
    { readonly run: AgentRun<O, true>; readonly events: AsyncIterator<RunEvent> } | undefined;
  /** Settles the result of a task this process does not run, from the durable store. */
  readonly settle: () => Promise<RunResult<O>>;
  readonly abort: (reason?: string) => void;
  readonly snapshot: TaskHandle<O>['snapshot'];
};

/**
 * A {@link TaskHandle} over a task. The first iteration yields the events its iterator holds and
 * then the live tail; a later iteration yields nothing, as a settled `AgentRun` does.
 */
export function createTaskHandle<O>(source: TaskHandleSource<O>): TaskHandle<O> {
  let iterated = false;
  return {
    id: source.id,
    contextId: source.contextId,
    ...(source.receipt === undefined ? {} : { receipt: source.receipt }),
    result: () => (source.live === undefined ? source.settle() : source.live.run.result()),
    abort: (reason) => source.abort(reason),
    snapshot: () => source.snapshot(),
    [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
      if (iterated || source.live === undefined) return emptyIterator();
      iterated = true;
      return source.live.events;
    },
  };
}

function emptyIterator(): AsyncIterator<RunEvent> {
  return { next: () => Promise.resolve({ value: undefined, done: true }) };
}

/** Whether a task input seeds a new context with a conversation. */
export function seedsConversation(
  input: TaskInput,
): input is Extract<TaskInput, { readonly conversation: unknown }> {
  return typeof input === 'object' && !Array.isArray(input) && 'conversation' in input;
}
