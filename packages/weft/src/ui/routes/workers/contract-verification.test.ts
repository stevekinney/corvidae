import { describe, expect, test } from 'bun:test';

import { activityContractHash } from '@lostgradient/weft';

import type { RegistrySnapshotSource } from '../system/registry-view.ts';
import {
  CONTRACT_DRIFT_DESCRIPTIONS,
  CONTRACT_DRIFT_LABELS,
  contractDriftSubject,
  manifestFileName,
  shellSafeFileStem,
  verificationCommands,
  verifyWorkerManifest,
  verifyWorkerManifests,
} from './contract-verification.ts';
import type { WorkerManifestDiagnostics } from './worker-manifest-diagnostics.ts';

const chargeSchema = {
  inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
  outputSchema: { type: 'object', properties: { chargeId: { type: 'string' } } },
};
const refundSchema = { inputSchema: { type: 'object', properties: { id: { type: 'string' } } } };

function snapshot(overrides: Partial<RegistrySnapshotSource> = {}): RegistrySnapshotSource {
  return {
    registryVersion: 2,
    generatedAt: '2026-10-01T00:00:00.000Z',
    workflows: [
      {
        manifestVersion: 1,
        name: 'checkout',
        workflowVersion: '2.0.0',
        revision: 'checkout-rev-2',
        contractHash: 'sha256:checkout-contract',
        contract: {
          name: 'checkout',
          workflowVersion: '2.0.0',
          activities: { charge: chargeSchema, refund: refundSchema },
        },
      },
      // Installed but inactive: never compared.
      {
        manifestVersion: 1,
        name: 'checkout',
        workflowVersion: '3.0.0',
        revision: 'checkout-rev-3',
        contractHash: 'sha256:checkout-next',
        contract: { name: 'checkout', workflowVersion: '3.0.0' },
      },
    ],
    activeRevisions: { checkout: 'checkout-rev-2' },
    activities: {},
    ...overrides,
  };
}

async function matchingDiagnostics(
  workerId = 'worker-a',
  workflows?: WorkerManifestDiagnostics['deploymentVersion']['workflows'],
): Promise<WorkerManifestDiagnostics> {
  return {
    instance: {
      workerId,
      queue: 'payments',
      health: 'active',
      connectedAt: 1,
      startedAt: 1,
      lastHeartbeatAt: 1,
      heartbeatAgeMs: 1,
    },
    deploymentVersion: {
      deploymentName: 'payments api',
      buildId: 'build/7',
      artifactDigest: 'sha256:artifact',
      runtimeName: 'bun',
      runtimeVersion: '1.3.0',
      sdkVersion: '0.20.0',
      manifestVersion: 1,
      protocolVersion: 3,
      manifestDigest: 'sha256:manifest',
      workflows: workflows ?? {
        checkout: {
          workflowVersion: '2.0.0',
          workflowRevision: 'checkout-rev-2',
          contractHash: 'sha256:checkout-contract',
          activities: {
            charge: {
              contractHash: await activityContractHash(chargeSchema),
              implementationRevision: 'charge-impl',
            },
            refund: {
              contractHash: await activityContractHash(refundSchema),
              implementationRevision: 'refund-impl',
            },
          },
        },
      },
    },
  };
}

describe('verifyWorkerManifest', () => {
  test('reports no drift when the manifest matches the active revision', async () => {
    const report = await verifyWorkerManifest(await matchingDiagnostics(), snapshot());
    expect(report.drift).toEqual([]);
    expect(report.workflows).toEqual(['checkout']);
    expect(report.workerId).toBe('worker-a');
    expect(report.manifestDigest).toBe('sha256:manifest');
  });

  test('reports workflow identity drift with the matching compatibility reason', async () => {
    const report = await verifyWorkerManifest(
      await matchingDiagnostics('worker-a', {
        checkout: {
          workflowVersion: '1.9.0',
          workflowRevision: 'checkout-rev-1',
          contractHash: 'sha256:old-contract',
          activities: {
            charge: {
              contractHash: await activityContractHash(chargeSchema),
              implementationRevision: 'x',
            },
            refund: {
              contractHash: await activityContractHash(refundSchema),
              implementationRevision: 'x',
            },
          },
        },
      }),
      snapshot(),
    );
    expect(report.drift).toEqual([
      {
        kind: 'workflow-revision-mismatch',
        workflowName: 'checkout',
        expected: 'checkout-rev-2',
        actual: 'checkout-rev-1',
        reason: 'artifact-revision-mismatch',
      },
      {
        kind: 'workflow-version-mismatch',
        workflowName: 'checkout',
        expected: '2.0.0',
        actual: '1.9.0',
        reason: 'workflow-version-incompatible',
      },
      {
        kind: 'workflow-contract-hash-mismatch',
        workflowName: 'checkout',
        expected: 'sha256:checkout-contract',
        actual: 'sha256:old-contract',
        reason: 'contract-hash-mismatch',
      },
    ]);
  });

  test('reports missing, extra, and mismatched activities', async () => {
    const report = await verifyWorkerManifest(
      await matchingDiagnostics('worker-a', {
        checkout: {
          workflowVersion: '2.0.0',
          workflowRevision: 'checkout-rev-2',
          contractHash: 'sha256:checkout-contract',
          activities: {
            charge: { contractHash: 'sha256:stale-charge', implementationRevision: 'x' },
            audit: { contractHash: 'sha256:audit', implementationRevision: 'x' },
          },
        },
      }),
      snapshot(),
    );
    expect(report.drift).toEqual([
      { kind: 'extra-activity', workflowName: 'checkout', activityName: 'audit' },
      {
        kind: 'activity-contract-hash-mismatch',
        workflowName: 'checkout',
        activityName: 'charge',
        expected: await activityContractHash(chargeSchema),
        actual: 'sha256:stale-charge',
        reason: 'contract-hash-mismatch',
      },
      { kind: 'missing-activity', workflowName: 'checkout', activityName: 'refund' },
    ]);
  });

  test('reports extra and missing workflows across the whole registry', async () => {
    const base = await matchingDiagnostics();
    const report = await verifyWorkerManifest(
      await matchingDiagnostics('worker-a', {
        ...base.deploymentVersion.workflows,
        legacy: {
          workflowVersion: '1.0.0',
          workflowRevision: 'legacy-rev',
          contractHash: 'sha256:legacy',
          activities: {},
        },
      }),
      snapshot({
        workflows: [
          ...snapshot().workflows,
          {
            manifestVersion: 1,
            name: 'billing',
            workflowVersion: '1.0.0',
            revision: 'billing-rev',
            contractHash: 'sha256:billing',
            contract: { name: 'billing', workflowVersion: '1.0.0' },
          },
        ],
        activeRevisions: { checkout: 'checkout-rev-2', billing: 'billing-rev' },
      }),
    );
    expect(report.drift).toEqual([
      { kind: 'extra-workflow', workflowName: 'legacy' },
      { kind: 'missing-workflow', workflowName: 'billing' },
    ]);
    expect(report.workflows).toEqual(['billing', 'checkout', 'legacy']);
  });

  test('scopes the comparison to one workflow when asked', async () => {
    const report = await verifyWorkerManifest(
      await matchingDiagnostics('worker-a', {}),
      snapshot(),
      'checkout',
    );
    expect(report.drift).toEqual([{ kind: 'missing-workflow', workflowName: 'checkout' }]);
    const unrelated = await verifyWorkerManifest(await matchingDiagnostics(), snapshot(), 'other');
    expect(unrelated.drift).toEqual([]);
    expect(unrelated.workflows).toEqual([]);
  });

  test('ignores inherited property names when matching activities', async () => {
    const report = await verifyWorkerManifest(
      await matchingDiagnostics('worker-a', {
        checkout: {
          workflowVersion: '2.0.0',
          workflowRevision: 'checkout-rev-2',
          contractHash: 'sha256:checkout-contract',
          activities: {
            charge: {
              contractHash: await activityContractHash(chargeSchema),
              implementationRevision: 'x',
            },
            refund: {
              contractHash: await activityContractHash(refundSchema),
              implementationRevision: 'x',
            },
            toString: { contractHash: 'sha256:x', implementationRevision: 'x' },
          },
        },
      }),
      snapshot(),
    );
    expect(report.drift).toEqual([
      { kind: 'extra-activity', workflowName: 'checkout', activityName: 'toString' },
    ]);
  });
});

describe('verifyWorkerManifests', () => {
  test('verifies only workers serving the workflow, sorted by worker', async () => {
    const reports = await verifyWorkerManifests(
      [
        await matchingDiagnostics('worker-b'),
        await matchingDiagnostics('worker-c', {}),
        await matchingDiagnostics('worker-a'),
      ],
      snapshot(),
      'checkout',
    );
    expect(reports.map((report) => report.workerId)).toEqual(['worker-a', 'worker-b']);
  });

  test('verifies every worker without a workflow filter', async () => {
    const reports = await verifyWorkerManifests(
      [await matchingDiagnostics('worker-b'), await matchingDiagnostics('worker-c', {})],
      snapshot(),
    );
    expect(reports.map((report) => report.drift.length)).toEqual([0, 1]);
  });
});

describe('presentation', () => {
  test('every drift kind has a label and a description', () => {
    expect(Object.keys(CONTRACT_DRIFT_LABELS).toSorted()).toEqual(
      Object.keys(CONTRACT_DRIFT_DESCRIPTIONS).toSorted(),
    );
  });

  test('names a drift entry by workflow or workflow.activity', () => {
    expect(contractDriftSubject({ kind: 'missing-workflow', workflowName: 'checkout' })).toBe(
      'checkout',
    );
    expect(
      contractDriftSubject({
        kind: 'missing-activity',
        workflowName: 'checkout',
        activityName: 'charge',
      }),
    ).toBe('checkout.charge');
  });
});

describe('verification commands', () => {
  test('uses the flags weft codegen and weft worker verify document', () => {
    // Flags per `packages/weft/src/cli/help-text.ts`: `weft codegen --from <path> --out <file>`
    // and `weft worker verify --manifest <path> --from <registry.json>`.
    expect(verificationCommands({ deploymentName: 'payments-api', buildId: 'build-7' })).toEqual({
      codegen: 'weft codegen --from weft-registry.json --out weft-registry.d.ts',
      verify:
        'weft worker verify --manifest payments-api-build-7.manifest.json --from weft-registry.json',
    });
  });

  test('falls back to a generic manifest name when no single worker is known', () => {
    expect(verificationCommands(undefined).verify).toBe(
      'weft worker verify --manifest worker-manifest.json --from weft-registry.json',
    );
  });

  test('keeps substituted identifiers shell-safe', () => {
    expect(shellSafeFileStem('payments api; rm -rf /')).toBe('payments-api-rm-rf');
    expect(shellSafeFileStem('$(whoami)')).toBe('whoami');
    expect(shellSafeFileStem('...')).toBe('worker');
    expect(shellSafeFileStem('a'.repeat(200))).toHaveLength(80);
    expect(manifestFileName({ deploymentName: 'payments api', buildId: 'build/7' })).toBe(
      'payments-api-build-7.manifest.json',
    );
  });
});
