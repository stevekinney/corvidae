/**
 * Keys and decoders of the two stored deployment records: a version, at
 * `worker-deployment-version:<deployment>:<build>`, and a deployment's routing pointer, at
 * `worker-deployment-routing:<deployment>`. Names and ids are URI-encoded in the key.
 *
 * A third record, the removal fence, is described in `deployment-removal-fence.ts`.
 */
import { decode } from '../core/codec/index.ts';
import type { WorkerDeploymentRouting, WorkerDeploymentVersion } from './deployment-routing.ts';

export const WORKER_DEPLOYMENT_VERSION_PREFIX = 'worker-deployment-version:';
export const WORKER_DEPLOYMENT_ROUTING_PREFIX = 'worker-deployment-routing:';

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
