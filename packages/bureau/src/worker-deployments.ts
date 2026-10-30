/**
 * Worker rollouts (COR-1813): `Bureau.deployments` reads and moves the routing pointer of a worker
 * deployment in Weft's `WorkerDeploymentCatalog`, so an operator can ramp a build, promote it, and
 * roll back without Weft's lower-level operations.
 *
 * Every move is one `setRouting` write fenced by a routing generation: the one the caller passed as
 * `expectedGeneration`, else the one this call just read. A pointer that moved in between makes the
 * write fail with `stale-generation` and nothing changes. Each move that committed is appended to
 * the audit trail, filed under `worker-deployment:<name>`; the trail is best effort, so a failure
 * to write the entry is reported through `diagnose` and never undoes the move.
 *
 * Bureau does not raise Weft's `worker:deployment-changed` event for these moves: it holds the
 * catalog, not the Weft server that owns the worker registry and the event stream. A host that needs
 * that announcement moves the pointer through Weft's own `weft.worker.deployments.*` operations.
 *
 * @module worker-deployments
 */

import type { WorkerDeploymentCatalog, WorkerDeploymentRouting } from '@lostgradient/weft';

import { auditTrailWorkerDeploymentOwnerId } from './audit-trail';

/** The routing pointer of a worker deployment, as Bureau reports it. */
export interface BureauWorkerDeploymentRouting {
  /** The deployment the pointer routes. */
  readonly deploymentName: string;
  /** The build that takes the new unpinned work the ramp does not. */
  readonly currentBuildId: string;
  /** The build that takes `rampBasisPoints` of new unpinned work, or `null` when none is ramping. */
  readonly rampingBuildId: string | null;
  /** The ramping build's share of new unpinned work, from 0 (none) to 10000 (all). */
  readonly rampBasisPoints: number;
  /**
   * The build that was current before the latest change of `currentBuildId`, which {@link
   * BureauWorkerDeployments.rollBack} returns to; `null` until the current build has changed once,
   * and for a pointer written before Weft recorded it.
   */
  readonly previousBuildId: string | null;
  /** Increases by one on every write; pass it back as `expectedGeneration` to fence a change. */
  readonly generation: number;
  /** When the pointer was last written, as an ISO-8601 timestamp. */
  readonly updatedAt: string;
}

/** Why a rollout move was refused. */
export type WorkerDeploymentRolloutReason =
  /** The deployment has no routing pointer yet; set one through Weft first. */
  | 'no-routing'
  /** A promote with no ramping build to promote. */
  | 'no-ramping-build'
  /** A roll back with no `previousBuildId` to return to. */
  | 'no-previous-build'
  /** A ramp whose build is the current build. */
  | 'same-as-current'
  /** A ramp share that is not an integer from 0 to 10000. */
  | 'invalid-ramp'
  /** The named build is not registered, or was removed. */
  | 'build-not-found'
  /** The named build is not `ready` (it is draining), so it cannot take new work. */
  | 'build-not-ready'
  /** The pointer moved past `expectedGeneration`, or another writer got there first. */
  | 'stale-generation';

/** A rollout move that was refused, with what a caller needs to retry or give up. */
export class WorkerDeploymentRolloutError extends Error {
  /** Why the move was refused. */
  readonly reason: WorkerDeploymentRolloutReason;
  /** The deployment the move named. */
  readonly deploymentName: string;
  /** The build the refusal is about, for `build-not-found`, `build-not-ready`, and `same-as-current`. */
  readonly buildId: string | undefined;
  /** The pointer's generation now, for `stale-generation`. */
  readonly currentGeneration: number | undefined;

  constructor(
    reason: WorkerDeploymentRolloutReason,
    message: string,
    details: {
      readonly deploymentName: string;
      readonly buildId?: string | undefined;
      readonly currentGeneration?: number | undefined;
    },
  ) {
    super(message);
    this.name = 'WorkerDeploymentRolloutError';
    this.reason = reason;
    this.deploymentName = details.deploymentName;
    this.buildId = details.buildId;
    this.currentGeneration = details.currentGeneration;
  }
}

/** The caller of a rollout move, for the audit entry it writes. */
export interface WorkerDeploymentRolloutContext {
  /** The owner string of the caller, recorded as the audit entry's `principal`; omitted when none. */
  readonly actor?: string | undefined;
}

/** The generation fence every move accepts. */
export interface WorkerDeploymentRolloutFence {
  /**
   * Apply the move only if the pointer is still at this generation, for example the `generation` a
   * preceding {@link BureauWorkerDeployments.get} returned. Omitted, the move is fenced by the
   * generation it reads itself, which still refuses a pointer that moves before it writes.
   */
  readonly expectedGeneration?: number | undefined;
}

/** The input of {@link BureauWorkerDeployments.ramp}. */
export interface WorkerDeploymentRampInput extends WorkerDeploymentRolloutFence {
  /** The deployment whose pointer moves. */
  readonly deploymentName: string;
  /** The build to ramp: ready, and different from the current build. */
  readonly buildId: string;
  /** The share of new unpinned work the build takes, from 0 to 10000. 0 stages it without traffic. */
  readonly rampBasisPoints: number;
}

/** The input of {@link BureauWorkerDeployments.promote} and {@link BureauWorkerDeployments.rollBack}. */
export interface WorkerDeploymentMoveInput extends WorkerDeploymentRolloutFence {
  /** The deployment whose pointer moves. */
  readonly deploymentName: string;
}

/** The rollouts of a Bureau, as `Bureau.deployments`. */
export interface BureauWorkerDeployments {
  /** The routing pointer of `deploymentName`, or `null` when it has none. */
  readonly get: (deploymentName: string) => Promise<BureauWorkerDeploymentRouting | null>;
  /**
   * Ramp `buildId`: it takes `rampBasisPoints` of new unpinned work, and the current build the
   * rest. Replaces any ramp in place. Refused with {@link WorkerDeploymentRolloutError}.
   */
  readonly ramp: (
    input: WorkerDeploymentRampInput,
    context?: WorkerDeploymentRolloutContext,
  ) => Promise<BureauWorkerDeploymentRouting>;
  /**
   * Make the ramping build the current build and clear the ramp, which records the replaced build
   * as `previousBuildId`. Refused with `no-ramping-build` when nothing is ramping.
   */
  readonly promote: (
    input: WorkerDeploymentMoveInput,
    context?: WorkerDeploymentRolloutContext,
  ) => Promise<BureauWorkerDeploymentRouting>;
  /**
   * Return to `previousBuildId` and clear any ramp; the build it replaces becomes the new
   * `previousBuildId`, so a second roll back undoes the first. Refused with `no-previous-build`
   * when the current build has never changed.
   */
  readonly rollBack: (
    input: WorkerDeploymentMoveInput,
    context?: WorkerDeploymentRolloutContext,
  ) => Promise<BureauWorkerDeploymentRouting>;
}

/** The kinds of rollout audit entry. */
export type WorkerDeploymentAuditType =
  'deployment.ramped' | 'deployment.promoted' | 'deployment.rolled-back';

/** One entry a rollout move appends to the audit trail, filed under `worker-deployment:<name>`. */
export interface WorkerDeploymentAuditEntry {
  readonly runId: string;
  readonly type: WorkerDeploymentAuditType;
  /** Scalars only, and a field that is absent is left out. */
  readonly detail: Readonly<Record<string, string | number>>;
  readonly principal?: string;
}

/** What {@link createBureauWorkerDeployments} is built from. */
export interface BureauWorkerDeploymentsOptions {
  /** Weft's catalog, which holds the versions and the routing pointers. */
  readonly catalog: WorkerDeploymentCatalog;
  /** The current time in epoch milliseconds, which the pointer's `updatedAt` records. */
  readonly now: () => number;
  /** Appends to the audit trail; resolves without writing when the Bureau keeps none. */
  readonly audit: (entry: WorkerDeploymentAuditEntry) => Promise<void>;
  /** Reports a failure that must not fail the move, such as an audit entry that could not be written. */
  readonly diagnose: (message: string, cause: unknown) => void;
}

function viewOf(routing: WorkerDeploymentRouting): BureauWorkerDeploymentRouting {
  return {
    deploymentName: routing.deploymentName,
    currentBuildId: routing.currentBuildId,
    rampingBuildId: routing.rampingBuildId ?? null,
    rampBasisPoints: routing.rampBasisPoints,
    previousBuildId: routing.previousBuildId ?? null,
    generation: routing.generation,
    updatedAt: new Date(routing.updatedAt).toISOString(),
  };
}

function staleGeneration(
  deploymentName: string,
  expectedGeneration: number,
  currentGeneration: number,
): WorkerDeploymentRolloutError {
  return new WorkerDeploymentRolloutError(
    'stale-generation',
    `Routing generation for deployment "${deploymentName}" changed concurrently (expected generation ${String(expectedGeneration)}); retry with generation ${String(currentGeneration)}.`,
    { deploymentName, currentGeneration },
  );
}

/** Build the rollouts of a Bureau over a Weft worker deployment catalog. */
export function createBureauWorkerDeployments(
  options: BureauWorkerDeploymentsOptions,
): BureauWorkerDeployments {
  const { catalog } = options;

  /**
   * The pointer a move decides from. A caller who named `expectedGeneration` is refused here with
   * `stale-generation` when the pointer has moved past it, before any other refusal is decided
   * from a pointer the caller never saw.
   */
  async function requireRouting(
    deploymentName: string,
    expectedGeneration: number | undefined,
  ): Promise<WorkerDeploymentRouting> {
    const routing = await catalog.getRouting(deploymentName);
    if (routing === null) {
      throw new WorkerDeploymentRolloutError(
        'no-routing',
        `Deployment "${deploymentName}" has no routing pointer yet.`,
        { deploymentName },
      );
    }
    if (expectedGeneration !== undefined && routing.generation !== expectedGeneration) {
      throw staleGeneration(deploymentName, expectedGeneration, routing.generation);
    }
    return routing;
  }

  /** Throws the typed refusal for a build that cannot take work: unknown, removed, or not ready. */
  async function requireReadyBuild(deploymentName: string, buildId: string): Promise<void> {
    const version = await catalog.getVersion(deploymentName, buildId);
    if (version === null || version.state === 'removed') {
      throw new WorkerDeploymentRolloutError(
        'build-not-found',
        `Deployment build ${deploymentName}/${buildId} does not exist.`,
        { deploymentName, buildId },
      );
    }
    if (version.state !== 'ready') {
      throw new WorkerDeploymentRolloutError(
        'build-not-ready',
        `Deployment build ${deploymentName}/${buildId} is ${version.state}, so it is not eligible for routing.`,
        { deploymentName, buildId },
      );
    }
  }

  /**
   * The one write behind every move: the pointer `next` describes, applied only at `fence`. The
   * builds it names are checked first for a typed refusal; `setRouting` checks them again inside
   * its conditional write, so a build that stops being ready in between fails there, and the
   * typed refusal is rebuilt from what the catalog holds now.
   */
  async function write(
    current: WorkerDeploymentRouting,
    next: { currentBuildId: string; rampingBuildId?: string; rampBasisPoints: number },
    fence: number,
  ): Promise<WorkerDeploymentRouting> {
    const buildIds = [next.currentBuildId, ...(next.rampingBuildId ? [next.rampingBuildId] : [])];
    for (const buildId of buildIds) await requireReadyBuild(current.deploymentName, buildId);
    let written: WorkerDeploymentRouting | null;
    try {
      written = await catalog.setRouting({
        deploymentName: current.deploymentName,
        currentBuildId: next.currentBuildId,
        ...(next.rampingBuildId === undefined ? {} : { rampingBuildId: next.rampingBuildId }),
        rampBasisPoints: next.rampBasisPoints,
        updatedAt: options.now(),
        expectedGeneration: fence,
      });
    } catch (error) {
      for (const buildId of buildIds) await requireReadyBuild(current.deploymentName, buildId);
      throw error;
    }
    if (written === null) {
      const latest = await catalog.getRouting(current.deploymentName);
      throw staleGeneration(current.deploymentName, fence, latest?.generation ?? 0);
    }
    return written;
  }

  async function audit(
    type: WorkerDeploymentAuditType,
    before: WorkerDeploymentRouting,
    after: WorkerDeploymentRouting,
    actor: string | undefined,
  ): Promise<void> {
    try {
      await options.audit({
        runId: auditTrailWorkerDeploymentOwnerId(after.deploymentName),
        type,
        detail: {
          deploymentName: after.deploymentName,
          fromBuildId: before.currentBuildId,
          currentBuildId: after.currentBuildId,
          ...(after.rampingBuildId === undefined ? {} : { rampingBuildId: after.rampingBuildId }),
          rampBasisPoints: after.rampBasisPoints,
          ...(after.previousBuildId === undefined
            ? {}
            : { previousBuildId: after.previousBuildId }),
          generation: after.generation,
        },
        ...(actor === undefined ? {} : { principal: actor }),
      });
    } catch (cause) {
      options.diagnose(
        `Could not record the ${type} audit entry for deployment "${after.deploymentName}".`,
        cause,
      );
    }
  }

  // Each move snapshots what it reads of the caller's `input` and `context` before its first
  // `await`: the caller owns both objects and may reuse them while the move is in flight.
  async function ramp(
    input: WorkerDeploymentRampInput,
    context?: WorkerDeploymentRolloutContext,
  ): Promise<BureauWorkerDeploymentRouting> {
    const { deploymentName, buildId, rampBasisPoints, expectedGeneration } = input;
    const actor = context?.actor;
    if (!Number.isInteger(rampBasisPoints) || rampBasisPoints < 0 || rampBasisPoints > 10_000) {
      throw new WorkerDeploymentRolloutError(
        'invalid-ramp',
        'rampBasisPoints must be an integer between 0 and 10000.',
        { deploymentName, buildId },
      );
    }
    const current = await requireRouting(deploymentName, expectedGeneration);
    if (buildId === current.currentBuildId) {
      throw new WorkerDeploymentRolloutError(
        'same-as-current',
        `Build ${deploymentName}/${buildId} is the current build, so it cannot also ramp.`,
        { deploymentName, buildId },
      );
    }
    const written = await write(
      current,
      { currentBuildId: current.currentBuildId, rampingBuildId: buildId, rampBasisPoints },
      current.generation,
    );
    await audit('deployment.ramped', current, written, actor);
    return viewOf(written);
  }

  async function promote(
    input: WorkerDeploymentMoveInput,
    context?: WorkerDeploymentRolloutContext,
  ): Promise<BureauWorkerDeploymentRouting> {
    const { deploymentName, expectedGeneration } = input;
    const actor = context?.actor;
    const current = await requireRouting(deploymentName, expectedGeneration);
    if (current.rampingBuildId === undefined) {
      throw new WorkerDeploymentRolloutError(
        'no-ramping-build',
        `Deployment "${deploymentName}" has no ramping build to promote.`,
        { deploymentName },
      );
    }
    const written = await write(
      current,
      { currentBuildId: current.rampingBuildId, rampBasisPoints: 0 },
      current.generation,
    );
    await audit('deployment.promoted', current, written, actor);
    return viewOf(written);
  }

  async function rollBack(
    input: WorkerDeploymentMoveInput,
    context?: WorkerDeploymentRolloutContext,
  ): Promise<BureauWorkerDeploymentRouting> {
    const { deploymentName, expectedGeneration } = input;
    const actor = context?.actor;
    const current = await requireRouting(deploymentName, expectedGeneration);
    if (current.previousBuildId === undefined) {
      throw new WorkerDeploymentRolloutError(
        'no-previous-build',
        `Deployment "${deploymentName}" has no previous build to roll back to.`,
        { deploymentName },
      );
    }
    const written = await write(
      current,
      { currentBuildId: current.previousBuildId, rampBasisPoints: 0 },
      current.generation,
    );
    await audit('deployment.rolled-back', current, written, actor);
    return viewOf(written);
  }

  return {
    get: async (deploymentName) => {
      const routing = await catalog.getRouting(deploymentName);
      return routing === null ? null : viewOf(routing);
    },
    ramp,
    promote,
    rollBack,
  };
}
