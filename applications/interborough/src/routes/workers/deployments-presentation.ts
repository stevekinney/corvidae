/**
 * Presentation of deployment versions and routing for the Deployments tab
 * (COR-277). Every rule about which build serves a workflow stays in Weft: the
 * explanation below asks `selectWorkerDeployment`, which the server also uses,
 * and reports its answer, so the console cannot disagree with the runtime.
 *
 * @module
 */
import {
  selectWorkerDeployment,
  type DeploymentRoutingCandidate,
  type WorkerDeploymentRouting,
  type WorkerDeploymentVersion,
} from '@lostgradient/weft';

import type { WorkerSummary } from './worker-catalog-types.ts';

/** `1250` basis points is `12.5%`. */
export function formatBasisPoints(basisPoints: number): string {
  const percent = basisPoints / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, '')}%`;
}

export type VersionBadgeVariant = 'success' | 'warning' | 'neutral';

const STATE_PRESENTATION: Readonly<
  Record<WorkerDeploymentVersion['state'], { label: string; variant: VersionBadgeVariant }>
> = {
  ready: { label: 'Ready', variant: 'success' },
  draining: { label: 'Draining', variant: 'warning' },
  removed: { label: 'Removed', variant: 'neutral' },
};

/** The version's lifecycle state, spelled out so it never rests on color. */
export function versionStatePresentation(version: Pick<WorkerDeploymentVersion, 'state'>) {
  return STATE_PRESENTATION[version.state];
}

export type VersionRole = 'current' | 'ramping' | 'none';

/** Whether a build is the routing pointer's current build, its ramping build, or neither. */
export function versionRole(routing: WorkerDeploymentRouting | null, buildId: string): VersionRole {
  if (routing?.currentBuildId === buildId) return 'current';
  if (routing?.rampingBuildId === buildId) return 'ramping';
  return 'none';
}

export interface VersionFleet {
  readonly workers: number;
  readonly inFlight: number;
  readonly concurrency: number;
  readonly draining: number;
  readonly drained: number;
}

/** Connected workers of one build, summed from the fleet list (their own report, not a join of live state into the catalog). */
export function versionFleet(
  workers: readonly WorkerSummary[],
  deploymentName: string,
  buildId: string,
): VersionFleet {
  const matching = workers.filter(
    (worker) => worker.deploymentName === deploymentName && worker.buildId === buildId,
  );
  return {
    workers: matching.length,
    inFlight: matching.reduce((total, worker) => total + worker.inFlight, 0),
    concurrency: matching.reduce((total, worker) => total + worker.concurrency, 0),
    draining: matching.filter((worker) => worker.health === 'draining').length,
    drained: matching.filter((worker) => worker.health === 'drained').length,
  };
}

/**
 * Why a build cannot be removed right now, in terms of this build, or
 * `undefined` when it can. "No available capacity" is never a reason removal is
 * allowed or refused: capacity says nothing about whether anything still
 * depends on the build.
 */
export function removalBlockedReason(
  version: WorkerDeploymentVersion,
  routing: WorkerDeploymentRouting | null,
  fleet: VersionFleet,
): string | undefined {
  const label = `${version.deploymentName}/${version.buildId}`;
  if (version.state === 'removed') return `Build ${label} is already removed.`;
  if (version.executionReferences > 0) {
    const count = version.executionReferences;
    return `Build ${label} is still referenced by ${count} execution${count === 1 ? '' : 's'} (pinned runs, schedules, pending requirements, attempts, or realms), so it stays reachable.`;
  }
  const role = versionRole(routing, version.buildId);
  if (role !== 'none') {
    return `Build ${label} is the ${role} build of its routing pointer. Route traffic to another build first.`;
  }
  if (fleet.workers > 0) {
    return fleet.workers === 1
      ? `1 connected worker still reports build ${label}. Drain it and let it disconnect first.`
      : `${fleet.workers} connected workers still report build ${label}. Drain them and let them disconnect first.`;
  }
  return undefined;
}

/** Moving traffic to an older build is a rollback, to a newer one a promotion. */
export function moveDirection(
  routing: WorkerDeploymentRouting | null,
  versions: readonly WorkerDeploymentVersion[],
  target: WorkerDeploymentVersion,
): 'promote' | 'rollback' {
  const current = versions.find((version) => version.buildId === routing?.currentBuildId);
  return current !== undefined && target.firstSeenAt < current.firstSeenAt ? 'rollback' : 'promote';
}

export interface BucketExplanation {
  /** The build the workflow id lands on, or `undefined` when no routed build can serve it. */
  readonly buildId: string | undefined;
  readonly text: string;
}

/**
 * Which build a workflow id deterministically lands on, as Weft decides it.
 * Every ready build is offered as a candidate with capacity, so the answer is
 * the routing decision itself and not a statement about live capacity.
 */
export function explainWorkflowBucket(
  deploymentName: string,
  workflowId: string,
  routing: WorkerDeploymentRouting | null,
  versions: readonly WorkerDeploymentVersion[],
): BucketExplanation {
  if (routing === null) {
    return {
      buildId: undefined,
      text: `${deploymentName} has no routing pointer yet, so no build is chosen for ${workflowId}. Set routing to choose one.`,
    };
  }
  const candidates: DeploymentRoutingCandidate[] = versions
    .filter((version) => version.state === 'ready')
    .map((version) => ({
      workerId: `version:${version.buildId}`,
      buildId: version.buildId,
      manifest: version.manifest,
      availableCapacity: 1,
    }));
  const selection = selectWorkerDeployment({ deploymentName, workflowId, routing, candidates });
  if (selection.candidate === undefined) {
    return { buildId: undefined, text: selection.message };
  }
  const { rampingBuildId, currentBuildId, rampBasisPoints, generation } = routing;
  if (rampingBuildId === undefined) {
    return {
      buildId: selection.buildId,
      text: `${workflowId} lands on build ${selection.buildId}, the current build: no build is ramping, so all unpinned traffic goes there.`,
    };
  }
  return selection.buildId === rampingBuildId
    ? {
        buildId: selection.buildId,
        text: `${workflowId} lands on build ${rampingBuildId}, the ramping build: its bucket for routing generation ${generation} falls inside the ${formatBasisPoints(rampBasisPoints)} sent to it.`,
      }
    : {
        buildId: selection.buildId,
        text: `${workflowId} lands on build ${currentBuildId}, the current build: its bucket for routing generation ${generation} falls outside the ${formatBasisPoints(rampBasisPoints)} sent to build ${rampingBuildId}.`,
      };
}
