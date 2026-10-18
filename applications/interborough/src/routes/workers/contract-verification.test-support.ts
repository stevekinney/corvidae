/** Shared fixtures for the COR-162 contract-verification tests. */
import { activityContractHash, contractHash } from '@lostgradient/weft';

import type { RegistrySnapshotSource } from '../system/registry-view.ts';
import { registryActivityContractHashes } from './contract-verification.ts';
import type { WorkerManifestDiagnostics } from './worker-manifest-diagnostics.ts';

type WorkerWorkflows = WorkerManifestDiagnostics['deploymentVersion']['workflows'];

const CHARGE_CONTRACT = {
  inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
  outputSchema: { type: 'object', properties: { chargeId: { type: 'string' } } },
};

/** The real `activityContractHash` of the active `checkout` revision's `charge` and `reserve` activities. */
export const CHARGE_HASH = await activityContractHash(CHARGE_CONTRACT);
export const RESERVE_HASH = await activityContractHash({});

const OLD_CHECKOUT_CONTRACT = {
  name: 'checkout',
  workflowVersion: '1.0.0',
  activities: { charge: {} },
};
const CHECKOUT_CONTRACT = {
  name: 'checkout',
  workflowVersion: '2.0.0',
  activities: { charge: CHARGE_CONTRACT, reserve: {} },
};
const REFUND_CONTRACT = { name: 'refund', workflowVersion: '1.0.0' };

/** Real `contractHash` values, so the snapshot passes `parseWorkflowRevisionManifest`. */
export const CHECKOUT_CONTRACT_HASH = await contractHash(CHECKOUT_CONTRACT);
const OLD_CHECKOUT_CONTRACT_HASH = await contractHash(OLD_CHECKOUT_CONTRACT);
const REFUND_CONTRACT_HASH = await contractHash(REFUND_CONTRACT);

export function workerManifest(
  workflows: WorkerWorkflows,
  overrides: Partial<{ workerId: string; deploymentName: string; buildId: string }> = {},
): WorkerManifestDiagnostics {
  return {
    instance: {
      workerId: overrides.workerId ?? 'worker-a',
      queue: 'payments',
      transport: 'websocket',
      health: 'active',
      connectedAt: 1,
      startedAt: 1,
      lastHeartbeatAt: 1,
      heartbeatAgeMs: 1,
      sessionGeneration: 1,
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
    contractHash: CHECKOUT_CONTRACT_HASH,
    activities: {
      charge: { contractHash: CHARGE_HASH, implementationRevision: 'impl-1' },
      reserve: { contractHash: RESERVE_HASH, implementationRevision: 'impl-1' },
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
        contractHash: OLD_CHECKOUT_CONTRACT_HASH,
        contract: OLD_CHECKOUT_CONTRACT,
      },
      {
        manifestVersion: 1,
        name: 'checkout',
        workflowVersion: '2.0.0',
        revision: 'rev-2',
        contractHash: CHECKOUT_CONTRACT_HASH,
        contract: CHECKOUT_CONTRACT,
      },
      {
        manifestVersion: 1,
        name: 'refund',
        workflowVersion: '1.0.0',
        revision: 'refund-rev',
        contractHash: REFUND_CONTRACT_HASH,
        contract: REFUND_CONTRACT,
      },
    ],
    activeRevisions: { checkout: 'rev-2', refund: 'refund-rev' },
    activities: {},
  };
}

/** {@link registryActivityContractHashes} of {@link registrySnapshot}. */
export const REGISTRY_HASHES = await registryActivityContractHashes(registrySnapshot());
