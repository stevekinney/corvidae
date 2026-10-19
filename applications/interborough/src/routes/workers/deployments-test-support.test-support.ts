/** Fixtures for the Deployments tab tests (COR-277). */
import type { WorkerDeploymentRouting, WorkerDeploymentVersionReport } from '@lostgradient/weft';

export const NOW = 1_700_000_000_000;

/** A retained build as `weft.worker.deployments.diagnostics` reports it. */
export function version(
  buildId: string,
  overrides: Partial<Omit<WorkerDeploymentVersionReport, 'manifest'>> = {},
): WorkerDeploymentVersionReport {
  const deploymentName = overrides.deploymentName ?? 'billing';
  const artifactDigest = overrides.artifactDigest ?? `sha256:artifact-${buildId}`;
  const manifest: WorkerDeploymentVersionReport['manifest'] = {
    manifestVersion: 1,
    protocolVersion: 8,
    sdkVersion: 'test',
    runtime: { name: 'bun', version: 'test' },
    deployment: { name: deploymentName, buildId, artifactDigest },
    workflows: {},
    capabilities: {},
  };
  return {
    deploymentName,
    buildId,
    artifactDigest,
    manifestDigest: `sha256:manifest-${buildId}`,
    state: 'ready',
    firstSeenAt: NOW - 100_000,
    executionReferences: 0,
    ...overrides,
    manifest,
  };
}

export function routing(overrides: Partial<WorkerDeploymentRouting> = {}): WorkerDeploymentRouting {
  return {
    deploymentName: 'billing',
    currentBuildId: 'build-a',
    rampBasisPoints: 0,
    generation: 3,
    updatedAt: NOW - 60_000,
    ...overrides,
  };
}

/** The JSON a diagnostics response carries. */
export function diagnosticsBody(
  versions: readonly WorkerDeploymentVersionReport[],
  pointer: WorkerDeploymentRouting | null,
) {
  return { versions, routing: pointer };
}
