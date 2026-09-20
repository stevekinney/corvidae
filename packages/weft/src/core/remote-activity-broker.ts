/**
 * The engine-owned seam for dispatching a `ctx.run()` activity call to a
 * remote worker (COR-152) instead of running it on the main thread or a
 * local Worker pool.
 *
 * **Ownership.** The engine owns the durable task record and the pending
 * workflow-operation adoption: the default broker
 * (`core/engine/remote-activity-broker.ts`) writes the task's `queued`
 * ledger record directly on `Engine.storage` and returns — no server,
 * socket, or worker needs to exist for this call to succeed durably. A
 * `serve()`d server (or the periodic reconciliation scan inside one, once
 * attached) discovers and dispatches `queued` records to a connected
 * worker; the server owns the transport (sockets, HTTP long-poll, session
 * timers) as a set of indexes DERIVED from the durable ledger, never as its
 * own source of truth. This mirrors {@link ExecutionStrategy}
 * (`core/execution-strategy.ts`): the engine defines and drives the seam,
 * and a transport plugs into it.
 *
 * **Test doubles.** `RemoteActivityBroker` is a constructor-time seam
 * (`activityExecution: { mode: 'remote', broker }`), not a post-construction
 * setter — a recording or poison double is supplied the same way a
 * `workerExecution.workerUrl` is, so tests can assert exactly what reaches
 * the envelope without needing a real server or socket.
 *
 * This module holds only the interface and its request shape, so
 * `core/types/options.ts` can reference `RemoteActivityBroker` without
 * depending on the concrete, storage-touching implementation
 * (`core/engine/remote-activity-broker.ts`) — the same split
 * `execution-strategy.ts` / `worker-execution-strategy.ts` already use.
 *
 * @module core/remote-activity-broker
 */

import type { RetryPolicy } from './types.ts';

/** One remote activity dispatch request, as `ctx.run()` builds it. */
export type RemoteActivityTaskRequest = Readonly<{
  /** The durable async-activity token this task is keyed by — see
   * `deriveAsyncActivityToken`. Doubles as the task ledger's `operationId`. */
  operationId: string;
  workflowId: string;
  /** The workflow's canonical registered type — derived from
   * `EngineInternals.workflowTypeByWorkflowId`, never from caller input
   * (acceptance criterion 3). */
  workflowType: string;
  /** Bare activity name; the broker qualifies it as `${workflowType}.${activityName}`. */
  activityName: string;
  input: unknown;
  headers: Readonly<Record<string, string>>;
  queue?: string;
  visibilityTimeoutMilliseconds?: number;
  retryPolicy?: RetryPolicy;
  workflowExecutionToken?: string;
  workflowRevision?: string;
  scheduleToCloseDeadline?: number;
}>;

/**
 * The engine-owned broker interface a `mode: 'remote'` `ctx.run()` dispatches
 * through. `enqueue` must be durably idempotent for a given `operationId`
 * (workflow replay re-derives the same deterministic token and calls
 * `enqueue` again) and must never throw merely because no server or worker
 * capacity is currently available — "no capacity" is represented by the task
 * remaining `queued`, not by a rejected promise.
 */
export interface RemoteActivityBroker {
  enqueue(request: RemoteActivityTaskRequest): Promise<void>;
}
