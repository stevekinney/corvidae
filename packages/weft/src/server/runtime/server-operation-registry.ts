import type { ConformanceTargetRunner } from '../../conformance/targets.ts';
import type { MetricsCollector } from '../../observability/metrics.ts';
import type { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import type { WorkerRegistry } from '../../worker/registry.ts';
import type { ServeOptions } from '../index.ts';
import type { OperationRegistry } from '../operation-catalog.ts';
import type { WorkerSessionTiming } from '../operations/get-worker-diagnostics.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import type { TaskQueue } from '../task-queue.ts';
import type { ServerContext } from './context.ts';
import { scheduleDelayedDispatch } from './task-dispatch.ts';
import { taskDispatchFromLedgerRecord } from './task-reconciliation.ts';

/**
 * Build the operation registry `serve()` dispatches through, wiring each
 * operation that needs a live collaborator to the server's own instances.
 *
 * `context` is a thunk because the registry is built while the context object
 * that holds it is still being constructed; it is only called when an
 * operation runs, by which point the context exists.
 */
export function createServerOperationRegistry(sources: {
  options: ServeOptions & { conformanceTargetRunner?: ConformanceTargetRunner | undefined };
  context: () => ServerContext;
  workerRegistry: WorkerRegistry;
  taskQueue: TaskQueue;
  metricsCollector: MetricsCollector;
  workerDeploymentCatalog: WorkerDeploymentCatalog;
  workerSessionTiming: WorkerSessionTiming;
}): OperationRegistry {
  const { options } = sources;
  return createLiveOperationRegistry({
    workerRegistry: sources.workerRegistry,
    taskQueue: sources.taskQueue,
    metricsCollector: sources.metricsCollector,
    workerDeploymentCatalog: sources.workerDeploymentCatalog,
    dispatchEvent: (event) => options.engine.dispatchEvent(event),
    workerSessionTiming: sources.workerSessionTiming,
    storage: options.engine.storage,
    // Dispatch a task `weft.tasks.deadletters.retry` queued now, not at the next
    // ledger sweep. A long-poll dead letter never reaches `taskQueue.complete()`
    // or `registry.completeTask()` (`applyTaskResult` skips both), so the server
    // still tracks the id and holds its worker slot, and the dispatch would be
    // refused as a duplicate, stranding the task. The dead attempt is over, so
    // release both. No completion callback is registered for a dispatched task,
    // so `complete` only releases the tracking.
    redispatchQueuedTask: (record) => {
      const context = sources.context();
      context.taskQueue.complete({ operationId: record.operationId, status: 'failed' });
      context.registry.completeTask(record.operationId);
      scheduleDelayedDispatch(context, options, taskDispatchFromLedgerRecord(record), 0);
    },
    ...(options.workerStartOverrideSigningSecret === undefined
      ? {}
      : { workerStartOverrideSigningSecret: options.workerStartOverrideSigningSecret }),
    ...(options.operations === undefined ? {} : { additionalOperations: options.operations }),
    conformanceTargetRunner: options.conformanceTargetRunner,
  });
}
