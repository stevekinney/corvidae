// ---------------------------------------------------------------------------
// Worker and deployment drain-state helpers
// ---------------------------------------------------------------------------

import type { WorkerDrainOptions, WorkerHealth, WorkerInfo } from './types.ts';

/** A drain marker: when it started and an optional operator-supplied reason. */
export type DrainRecord = {
  reason?: string;
  startedAt: number;
};

export function createDrainRecord(options?: WorkerDrainOptions): DrainRecord {
  return {
    startedAt: options?.updatedAt ?? Date.now(),
    ...(options?.reason !== undefined ? { reason: options.reason } : {}),
  };
}

/**
 * Operator drain markers above the worker level. A deployment marker covers
 * every worker that reports the deployment name; a build marker covers only
 * the workers that report that exact `(deploymentName, buildId)` pair, so one
 * version can be drained and resumed without touching its siblings.
 */
export type DrainStates = Readonly<{
  deployments: ReadonlyMap<string, DrainRecord>;
  builds: ReadonlyMap<string, DrainRecord>;
}>;

/** Key of a build drain marker. A NUL cannot appear in a deployment name or build id. */
export function buildDrainKey(deploymentName: string, buildId: string): string {
  return `${deploymentName}\u0000${buildId}`;
}

/**
 * The drain record covering `worker`: its own explicit marker if set, then its
 * deployment's marker, then its build's (when the worker declares them).
 */
export function drainRecordForWorker(
  worker: WorkerInfo,
  states: DrainStates,
): DrainRecord | undefined {
  if (worker.drainStartedAt !== undefined) {
    return {
      startedAt: worker.drainStartedAt,
      ...(worker.drainReason !== undefined ? { reason: worker.drainReason } : {}),
    };
  }
  if (worker.deploymentName === undefined) return undefined;
  const deployment = states.deployments.get(worker.deploymentName);
  if (deployment !== undefined || worker.buildId === undefined) return deployment;
  return states.builds.get(buildDrainKey(worker.deploymentName, worker.buildId));
}

export function isWorkerDraining(worker: WorkerInfo, states: DrainStates): boolean {
  return drainRecordForWorker(worker, states) !== undefined;
}

export function workerHealth(worker: WorkerInfo, states: DrainStates): WorkerHealth {
  if (!isWorkerDraining(worker, states)) return 'active';
  return worker.inFlight > 0 ? 'draining' : 'drained';
}
