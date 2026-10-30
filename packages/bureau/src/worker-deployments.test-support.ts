/**
 * Fixtures for the worker rollout tests (COR-1813): a Weft deployment catalog holding ready builds
 * of one deployment, `billing`.
 */
import { MemoryStorage } from '@lostgradient/storage';
import { WorkerDeploymentCatalog } from '@lostgradient/weft';

/** The deployment every fixture build belongs to. */
export const DEPLOYMENT = 'billing';

/** A catalog over `storage` with a ready build for each of `buildIds`. */
export async function catalogWithBuilds(
  buildIds: readonly string[],
  storage: MemoryStorage = new MemoryStorage(),
): Promise<WorkerDeploymentCatalog> {
  const catalog = new WorkerDeploymentCatalog(storage);
  for (const buildId of buildIds) {
    await catalog.registerVersion({
      deploymentName: DEPLOYMENT,
      buildId,
      artifactDigest: `sha256:${buildId}`,
      manifestDigest: `sha256:manifest-${buildId}`,
      manifest: {
        manifestVersion: 1,
        protocolVersion: 1,
        sdkVersion: 'test',
        runtime: { name: 'bun', version: 'test' },
        deployment: { name: DEPLOYMENT, buildId, artifactDigest: `sha256:${buildId}` },
        workflows: {},
        capabilities: {},
      },
      state: 'ready',
      firstSeenAt: 1,
    });
  }
  return catalog;
}

/** Point the deployment at `buildId` as its current build, the way a Weft server does first. */
export async function routeTo(
  catalog: WorkerDeploymentCatalog,
  buildId: string,
  updatedAt = 1_000,
): Promise<void> {
  const routed = await catalog.setRouting({
    deploymentName: DEPLOYMENT,
    currentBuildId: buildId,
    rampBasisPoints: 0,
    updatedAt,
  });
  if (routed === null) throw new Error('The fixture could not route the deployment.');
}
