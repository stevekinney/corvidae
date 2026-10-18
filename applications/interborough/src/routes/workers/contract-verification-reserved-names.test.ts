/**
 * Workflow and activity names that collide with `Object.prototype` members
 * are valid, so every membership check in contract verification must read
 * own properties only (COR-162 review).
 */
import { describe, expect, test } from 'bun:test';

import type { RegistrySnapshotSource } from '../system/registry-view.ts';
import {
  matchingCheckout,
  REGISTRY_HASHES,
  registrySnapshot,
  workerManifest,
} from './contract-verification.test-support.ts';
import {
  registryActivityContractHashes,
  verifyRegistryWorkflow,
  verifyWorkerContracts,
} from './contract-verification.ts';

const RESERVED_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'] as const;

/** A registry whose only active workflow, and its only activity, are named `name`. */
function reservedRegistry(name: string): RegistrySnapshotSource {
  // JSON.parse makes `__proto__` an own key, as it is on the wire; an
  // object literal would set the prototype instead.
  const key = JSON.stringify(name);
  return JSON.parse(`{
    "registryVersion": 2,
    "workflows": [{
      "manifestVersion": 1,
      "name": ${key},
      "workflowVersion": "1.0.0",
      "revision": "reserved-rev",
      "contractHash": "sha256:reserved",
      "contract": { "name": ${key}, "workflowVersion": "1.0.0", "activities": { ${key}: {} } }
    }],
    "activeRevisions": { ${key}: "reserved-rev" },
    "activities": {}
  }`) as RegistrySnapshotSource;
}

/** A worker workflow object whose activities are parsed from JSON, so reserved keys are own. */
function workflowWithActivities(activities: Record<string, string>) {
  const parsed = JSON.parse(
    `{${Object.entries(activities)
      .map(
        ([name, hash]) =>
          `${JSON.stringify(name)}:{"contractHash":${JSON.stringify(hash)},"implementationRevision":"i"}`,
      )
      .join(',')}}`,
  ) as ReturnType<typeof matchingCheckout>['activities'];
  return { ...matchingCheckout(), activities: { ...matchingCheckout().activities, ...parsed } };
}

describe('reserved workflow and activity names', () => {
  for (const name of RESERVED_NAMES) {
    test(`a worker activity named ${name} that the registry lacks is extra`, () => {
      const result = verifyWorkerContracts(
        workerManifest({ checkout: workflowWithActivities({ [name]: 'sha256:reserved' }) }),
        registrySnapshot(),
        REGISTRY_HASHES,
      );
      const activity = result.workflows[0]!.activities.find((entry) => entry.name === name);

      expect(activity).toEqual({ name, status: 'extra', workerContractHash: 'sha256:reserved' });
    });

    test(`a registry workflow named ${name} that the worker does not advertise is reported`, async () => {
      const registry = reservedRegistry(name);
      const result = verifyWorkerContracts(
        workerManifest({}),
        registry,
        await registryActivityContractHashes(registry),
      );

      expect(result.notAdvertised).toEqual([name]);
      expect(result.workflows).toEqual([]);
    });

    test(`verifyRegistryWorkflow(${name}) never treats an inherited member as a worker workflow`, async () => {
      const registry = reservedRegistry(name);
      const result = verifyRegistryWorkflow(
        name,
        [workerManifest({ checkout: matchingCheckout() })],
        registry,
        await registryActivityContractHashes(registry),
      );

      expect(result.workers).toEqual([]);
      expect(result.workersNotAdvertising).toBe(1);
    });

    test(`a worker that serves workflow and activity ${name} verifies against the registry`, async () => {
      const registry = reservedRegistry(name);
      const hashes = await registryActivityContractHashes(registry);
      const expectedHash = hashes.get(name)!.get(name)!;
      const workflows = JSON.parse(
        JSON.stringify({
          [name]: {
            workflowVersion: '1.0.0',
            workflowRevision: 'reserved-rev',
            contractHash: 'sha256:reserved',
            activities: { [name]: { contractHash: expectedHash, implementationRevision: 'i' } },
          },
        }),
      ) as Parameters<typeof workerManifest>[0];
      const result = verifyWorkerContracts(workerManifest(workflows), registry, hashes);

      expect(result.hasDrift).toBe(false);
      expect(result.notAdvertised).toEqual([]);
      expect(result.workflows.map((entry) => [entry.workflow, entry.status])).toEqual([
        [name, 'matched'],
      ]);
      expect(result.workflows[0]!.activities).toEqual([
        {
          name,
          status: 'matched',
          workerContractHash: expectedHash,
          registryContractHash: expectedHash,
        },
      ]);
    });
  }
});
