/** Shared fixtures for the COR-162 contract-verification tests. */
import type { RegistrySnapshotSource } from '../system/registry-view.ts';
import type { WorkerManifestDiagnostics } from './worker-manifest-diagnostics.ts';

type WorkerWorkflows = WorkerManifestDiagnostics['deploymentVersion']['workflows'];

export function workerManifest(
  workflows: WorkerWorkflows,
  overrides: Partial<{ workerId: string; deploymentName: string; buildId: string }> = {},
): WorkerManifestDiagnostics {
  return {
    instance: {
      workerId: overrides.workerId ?? 'worker-a',
      queue: 'payments',
      health: 'active',
      connectedAt: 1,
      startedAt: 1,
      lastHeartbeatAt: 1,
      heartbeatAgeMs: 1,
    },
    deploymentVersion: {
      deploymentName: overrides.deploymentName ?? 'payments-api',
      buildId: overrides.buildId ?? 'build-7',
      artifactDigest: 'sha256:artifact',
      runtimeName: 'bun',
      runtimeVersion: '1.4.0',
      sdkVersion: '0.20.0',
      manifestVersion: 1,
      protocolVersion: 3,
      manifestDigest: 'sha256:manifest',
      workflows,
    },
  };
}

/** A worker workflow that matches {@link registrySnapshot}'s active `checkout` revision exactly. */
export function matchingCheckout(): WorkerWorkflows[string] {
  return {
    workflowVersion: '2.0.0',
    workflowRevision: 'rev-2',
    contractHash: 'sha256:checkout-contract',
    activities: {
      charge: { contractHash: 'sha256:charge', implementationRevision: 'impl-1' },
      reserve: { contractHash: 'sha256:reserve', implementationRevision: 'impl-1' },
    },
  };
}

/**
 * Two installed `checkout` revisions (only `rev-2` active), plus an active
 * `refund` revision.
 */
export function registrySnapshot(): RegistrySnapshotSource {
  return {
    registryVersion: 2,
    workflows: [
      {
        manifestVersion: 1,
        name: 'checkout',
        workflowVersion: '1.0.0',
        revision: 'rev-1',
        contractHash: 'sha256:old-checkout-contract',
        contract: { name: 'checkout', workflowVersion: '1.0.0', activities: { charge: {} } },
      },
      {
        manifestVersion: 1,
        name: 'checkout',
        workflowVersion: '2.0.0',
        revision: 'rev-2',
        contractHash: 'sha256:checkout-contract',
        contract: {
          name: 'checkout',
          workflowVersion: '2.0.0',
          activities: { charge: {}, reserve: {} },
        },
      },
      {
        manifestVersion: 1,
        name: 'refund',
        workflowVersion: '1.0.0',
        revision: 'refund-rev',
        contractHash: 'sha256:refund-contract',
        contract: { name: 'refund', workflowVersion: '1.0.0' },
      },
    ],
    activeRevisions: { checkout: 'rev-2', refund: 'refund-rev' },
    activities: {},
  };
}
