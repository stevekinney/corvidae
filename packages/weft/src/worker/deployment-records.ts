/**
 * Keys and decoders of the stored deployment records. Names and ids are URI-encoded in every key,
 * so a name containing the `:` separator cannot collide with a neighbour.
 *
 * - **Version**, at `worker-deployment-version:<deployment>:<build>`: the MessagePack encoding of a
 *   `WorkerDeploymentVersion`. Its `state` is `ready`, `draining` or `removed`.
 * - **Routing pointer**, at `worker-deployment-routing:<deployment>`: the MessagePack encoding of a
 *   `WorkerDeploymentRouting`.
 * - **Binding stamp**, at `worker-deployment-binding:<deployment>:<build>`: sixteen random bytes,
 *   written blind by every commit that binds durable work to the build (a run's worker binding, or
 *   a task-ledger entry whose requirement names the build), in the same batch as that work. Absent
 *   means nothing has ever bound to the build. Only `remove` reads it, to condition its write on
 *   the stamp it read before it scanned, so any binding that commits after the scan began changes
 *   the stamp and makes the removal rescan. It is compared and never decoded.
 * - **Removal tombstone**, at `worker-deployment-removed:<deployment>:<build>`: one opaque byte,
 *   written once, in the same batch as the version record's `removed` state, and never deleted.
 *   Every commit that binds durable work to the build requires it to be absent, so a binding that
 *   meets a removed build fails and binds nothing. It is checked for presence and never decoded.
 *
 * Together they make removal optimistic concurrency, not a lock: nothing is held, so nothing can be
 * left behind by a crash, and there is nothing to reconcile.
 */
import { decode } from '../core/codec/index.ts';
import type { BatchOperation, ConditionalBatchCondition } from '../storage/interface.ts';
import type { WorkerDeploymentRouting, WorkerDeploymentVersion } from './deployment-routing.ts';

export const WORKER_DEPLOYMENT_VERSION_PREFIX = 'worker-deployment-version:';
export const WORKER_DEPLOYMENT_ROUTING_PREFIX = 'worker-deployment-routing:';
export const WORKER_DEPLOYMENT_BINDING_PREFIX = 'worker-deployment-binding:';
export const WORKER_DEPLOYMENT_REMOVED_PREFIX = 'worker-deployment-removed:';

/** A build, named the way the catalog names it. */
export type WorkerBuildIdentity = Readonly<{ deploymentName: string; buildId: string }>;

export function bindingStampKey(deploymentName: string, buildId: string): string {
  return `${WORKER_DEPLOYMENT_BINDING_PREFIX}${encodeURIComponent(deploymentName)}:${encodeURIComponent(buildId)}`;
}

export function removedTombstoneKey(deploymentName: string, buildId: string): string {
  return `${WORKER_DEPLOYMENT_REMOVED_PREFIX}${encodeURIComponent(deploymentName)}:${encodeURIComponent(buildId)}`;
}

/** A fresh stamp value: sixteen random bytes. */
export function newBindingStamp(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * What every commit that binds durable work to `build` adds to its own batch: the condition that
 * the build's tombstone is absent, and a blind put of a fresh stamp. Neither reads the other's
 * key, so concurrent bindings to one build never conflict with each other.
 */
export function workerBuildBinding(build: WorkerBuildIdentity): {
  condition: ConditionalBatchCondition;
  operation: BatchOperation;
} {
  return {
    condition: {
      key: removedTombstoneKey(build.deploymentName, build.buildId),
      expectedValue: null,
    },
    operation: {
      type: 'put',
      key: bindingStampKey(build.deploymentName, build.buildId),
      value: newBindingStamp(),
    },
  };
}

export function decodeVersion(value: Uint8Array): WorkerDeploymentVersion {
  const decoded = decode(value) as Partial<WorkerDeploymentVersion>;
  const valid = [
    typeof decoded.deploymentName === 'string',
    typeof decoded.buildId === 'string',
    typeof decoded.artifactDigest === 'string',
    typeof decoded.manifestDigest === 'string',
    typeof decoded.firstSeenAt === 'number',
    ['ready', 'draining', 'removed'].includes(decoded.state ?? ''),
    typeof decoded.manifest === 'object',
    decoded.manifest !== null,
  ].every(Boolean);
  if (!valid) throw new Error('Invalid worker deployment version record.');
  const deployment = decoded.manifest!.deployment;
  if (
    deployment.name !== decoded.deploymentName ||
    deployment.buildId !== decoded.buildId ||
    deployment.artifactDigest !== decoded.artifactDigest
  )
    throw new Error('Worker deployment version manifest identity disagrees with its storage key.');
  // A record written before references were computed carries a stored `executionReferences`
  // counter that nothing maintained. It is dropped here, so it can never be read as a count.
  const { executionReferences: _legacyCounter, ...version } = decoded as WorkerDeploymentVersion & {
    executionReferences?: number;
  };
  return version;
}

export function decodeRouting(value: Uint8Array): WorkerDeploymentRouting {
  const decoded = decode(value) as Partial<WorkerDeploymentRouting>;
  const valid = [
    typeof decoded.deploymentName === 'string',
    typeof decoded.currentBuildId === 'string',
    Number.isInteger(decoded.generation),
    (decoded.generation ?? 0) >= 1,
    Number.isInteger(decoded.rampBasisPoints),
    (decoded.rampBasisPoints ?? -1) >= 0,
    (decoded.rampBasisPoints ?? 10_001) <= 10_000,
    typeof decoded.updatedAt === 'number',
  ].every(Boolean);
  if (!valid) throw new Error('Invalid worker deployment routing record.');
  return decoded as WorkerDeploymentRouting;
}

export function versionKey(deploymentName: string, buildId: string): string {
  return `${WORKER_DEPLOYMENT_VERSION_PREFIX}${encodeURIComponent(deploymentName)}:${encodeURIComponent(buildId)}`;
}

export function routingKey(deploymentName: string): string {
  return `${WORKER_DEPLOYMENT_ROUTING_PREFIX}${encodeURIComponent(deploymentName)}`;
}
