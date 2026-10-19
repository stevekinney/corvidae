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
  builds: BuildDrainMarkers;
}>;

/**
 * Build drain markers, keyed by deployment name and then build id in nested maps. A deployment
 * name and a build id are free text, so no separator joins them safely: two different pairs can
 * read the same once joined. The same shape `DeploymentConsistencyGuard` uses.
 */
export class BuildDrainMarkers {
  readonly #markers = new Map<string, Map<string, DrainRecord>>();

  get(deploymentName: string, buildId: string): DrainRecord | undefined {
    return this.#markers.get(deploymentName)?.get(buildId);
  }

  has(deploymentName: string, buildId: string): boolean {
    return this.get(deploymentName, buildId) !== undefined;
  }

  set(deploymentName: string, buildId: string, record: DrainRecord): void {
    const builds = this.#markers.get(deploymentName) ?? new Map<string, DrainRecord>();
    builds.set(buildId, record);
    this.#markers.set(deploymentName, builds);
  }

  delete(deploymentName: string, buildId: string): void {
    const builds = this.#markers.get(deploymentName);
    if (builds === undefined) return;
    builds.delete(buildId);
    if (builds.size === 0) this.#markers.delete(deploymentName);
  }
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
  return states.builds.get(worker.deploymentName, worker.buildId);
}

export function isWorkerDraining(worker: WorkerInfo, states: DrainStates): boolean {
  return drainRecordForWorker(worker, states) !== undefined;
}

export function workerHealth(worker: WorkerInfo, states: DrainStates): WorkerHealth {
  if (!isWorkerDraining(worker, states)) return 'active';
  return worker.inFlight > 0 ? 'draining' : 'drained';
}
