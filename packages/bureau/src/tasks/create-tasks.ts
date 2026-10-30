import type { AgentRun, RunEvent, RunResult, StepRecord } from '@lostgradient/operative';

import type { BureauChildren } from '../child-topology.ts';
import type { RunCreationReceipt } from '../command-ledger.ts';
import type { TaskRegistry } from '../task-registry.ts';
import { createTaskResponder, type TaskResponderDependencies } from './respond-to-task.ts';
import {
  INSPECTED_STEP_LIMIT,
  type BureauTasks,
  type DurableEventHistoryRead,
  type DurableEventHistorySubscribe,
  type TaskHandle,
  type TaskInput,
  type TaskInspection,
} from '../types.ts';

/**
 * What {@link createTasks} composes `bureau.tasks` from: the Bureau's own task implementations,
 * which share its run state, session store, durable engine, and command ledger and so are built
 * where that state lives, the task registry, the durable event history the run owner kind is read
 * from, and the child topology `inspect` reports.
 */
export type TasksDependencies = {
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
  /** The error a missing task is refused with. */
  readonly notFound: (message: string) => Error;
  /** The reviews, ledger, and refusals {@link BureauTasks.respond} answers with, over `registry`. */
  readonly responder: Omit<TaskResponderDependencies, 'registry'>;
};

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
      return {
        task,
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
          effectiveContext: asked === undefined ? null : (record.effectiveContext ?? null),
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
