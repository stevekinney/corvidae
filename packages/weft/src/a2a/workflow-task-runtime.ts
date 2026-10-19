/**
 * Keeps a workflow agent's A2A tasks in line with the workflows they serve.
 *
 * A task changes only by reconciliation: the runtime reads the workflow from
 * `engine.get`, projects it through `workflow-task-projection.ts`, and commits the
 * difference to the task's durable event log, then hands each appended event to the
 * push-notification sender. It reconciles a task whenever a request reads it, and
 * whenever the engine reports a lifecycle or signal event for its workflow, so a
 * streaming subscriber follows the workflow live and a task whose workflow changed
 * while no handler ran catches up on its next read.
 *
 * The persisted `waitingForSignals` still names a signal for a moment after the
 * signal is delivered, and a workflow that waits for the same name again lists it
 * once more. So after a delivery the runtime records which name it delivered and
 * treats that name as consumed until the engine reports a new `signal:waiting` for
 * the workflow. The record is in memory: a restart forgets it, and the persisted list
 * is then read as it stands.
 *
 * @module a2a/workflow-task-runtime
 */

import type { PushNotificationSender, User } from '@a2a-js/sdk/server';
import { ServerCallContext } from '@a2a-js/sdk/server';

import type { Engine } from '../core/engine.ts';
import type { WorkflowState } from '../core/types/state.ts';
import { type A2ACallerScope, callerScope } from './store-support.ts';
import type { StoredWorkflowTask, TaskCommit, TaskEventLog, TaskOwner } from './task-event-log.ts';
import { reconcileTask, type WorkflowResultArtifacts } from './workflow-task-projection.ts';

/** The engine events after which a workflow's task may read differently. */
const RECONCILING_EVENTS = [
  'workflow:started',
  'workflow:completed',
  'workflow:failed',
  'workflow:cancelled',
  'workflow:timed-out',
  'workflow:suspended',
  'workflow:resumed',
  'signal:waiting',
  'signal:received',
  'signal:delivered',
] as const;

const SIGNAL_WAITING = 'signal:waiting';

/** The owner record a caller's tasks carry. */
export function taskOwnerOf(context: ServerCallContext): TaskOwner {
  const user = context.user;
  return {
    tenant: context.tenant ?? '',
    authenticated: user?.isAuthenticated === true,
    userName: user?.userName ?? '',
  };
}

/** A call context with the owner's scope, for work no request is waiting on. */
export function contextOfOwner(owner: TaskOwner): ServerCallContext {
  const user: User = { isAuthenticated: owner.authenticated, userName: owner.userName };
  return new ServerCallContext({
    user,
    ...(owner.tenant === '' ? {} : { tenant: owner.tenant }),
  });
}

type DeliveredSignal = { readonly name: string; readonly generation: number };

export type WorkflowTaskRuntimeOptions = {
  readonly engine: Engine;
  readonly namespace: string;
  readonly log: TaskEventLog;
  readonly sender: PushNotificationSender;
  readonly now: () => number;
  readonly onError: (error: unknown) => void;
  /** The artifacts a completed workflow's result is published as. */
  readonly artifactsOf: WorkflowResultArtifacts;
};

export type WorkflowTaskRuntime = {
  scopeOf(context: ServerCallContext): A2ACallerScope;
  /**
   * Bring the task in line with its workflow and return it, or `undefined` when the
   * caller's scope holds no such task.
   */
  reconcile(taskId: string, context: ServerCallContext): Promise<StoredWorkflowTask | undefined>;
  /** Commit `commit`'s events to push delivery, in order. */
  publish(commit: TaskCommit | undefined, context: ServerCallContext): Promise<void>;
  /** The signal waits of `state` still open, discounting a signal just delivered. */
  liveWaits(state: WorkflowState): readonly string[];
  /** Note the signal generation before a delivery. */
  beginDelivery(taskId: string): number;
  /** Record that `name` was delivered, unless a new wait began since `generation`. */
  recordDelivery(taskId: string, name: string, generation: number): void;
  /** Forget a delivery that failed. */
  abandonDelivery(taskId: string): void;
  /** Resolves once every reconciliation started by an engine event has settled. */
  idle(): Promise<void>;
  /** Stop listening to the engine. */
  dispose(): void;
};

export function createWorkflowTaskRuntime(
  options: WorkflowTaskRuntimeOptions,
): WorkflowTaskRuntime {
  const { engine, namespace, log, sender, now, onError, artifactsOf } = options;
  /** Signal-wait generations of workflows with a delivery in flight or recorded. */
  const generations = new Map<string, number>();
  const delivered = new Map<string, DeliveredSignal>();
  /** One reconciliation at a time per task, so commits arrive in order. */
  const chains = new Map<string, Promise<unknown>>();
  const background = new Set<Promise<void>>();
  let disposed = false;

  function liveWaits(state: WorkflowState): readonly string[] {
    const waits = state.waitingForSignals ?? [];
    const consumed = delivered.get(state.id);
    if (consumed === undefined || generations.get(state.id) !== consumed.generation) return waits;
    return waits.filter((name) => name !== consumed.name);
  }

  function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    chains.set(key, next);
    const evict = (): void => {
      if (chains.get(key) === next) chains.delete(key);
    };
    void next.then(evict, evict);
    return next;
  }

  async function publish(commit: TaskCommit | undefined, context: ServerCallContext) {
    if (commit === undefined) return;
    for (const entry of commit.appended) {
      try {
        await sender.send(entry.event, context, commit.stored.task);
      } catch (error) {
        onError(error);
      }
    }
  }

  function reconcileInScope(
    scope: A2ACallerScope,
    taskId: string,
    context: ServerCallContext,
  ): Promise<StoredWorkflowTask | undefined> {
    return serialize(`${scope.tenant}\0${scope.owner}\0${taskId}`, async () => {
      const state = await engine.get(taskId);
      if (state === null) return log.read(scope, taskId);
      const waits = liveWaits(state);
      const timestamp = new Date(now()).toISOString();
      const commit = await log.commit(scope, taskId, (stored) =>
        reconcileTask(stored.task, state, waits, timestamp, artifactsOf),
      );
      await publish(commit, context);
      return commit?.stored;
    });
  }

  async function reconcileWorkflow(workflowId: string): Promise<void> {
    const owner = await log.findOwner(workflowId);
    if (owner === undefined || disposed) return;
    const context = contextOfOwner(owner);
    await reconcileInScope(callerScope(namespace, context), workflowId, context);
  }

  const listener = (event: Event): void => {
    const workflowId: unknown = (event as Event & { workflowId?: unknown }).workflowId;
    if (typeof workflowId !== 'string') return;
    if (event.type === SIGNAL_WAITING) {
      const generation = generations.get(workflowId);
      if (generation !== undefined) generations.set(workflowId, generation + 1);
    } else if (event.type.startsWith('workflow:') && event.type !== 'workflow:started') {
      generations.delete(workflowId);
      delivered.delete(workflowId);
    }
    const work = reconcileWorkflow(workflowId).catch(onError);
    background.add(work);
    void work.finally(() => background.delete(work));
  };
  for (const type of RECONCILING_EVENTS) engine.addEventListener(type, listener);

  return {
    scopeOf: (context) => callerScope(namespace, context),
    reconcile: (taskId, context) =>
      reconcileInScope(callerScope(namespace, context), taskId, context),
    publish,
    liveWaits,
    beginDelivery(taskId) {
      const generation = generations.get(taskId) ?? 0;
      generations.set(taskId, generation);
      return generation;
    },
    recordDelivery(taskId, name, generation) {
      if (generations.get(taskId) === generation) delivered.set(taskId, { name, generation });
    },
    abandonDelivery(taskId) {
      if (!delivered.has(taskId)) generations.delete(taskId);
    },
    async idle() {
      while (background.size > 0) await Promise.allSettled(background);
    },
    dispose() {
      disposed = true;
      for (const type of RECONCILING_EVENTS) engine.removeEventListener(type, listener);
    },
  };
}
