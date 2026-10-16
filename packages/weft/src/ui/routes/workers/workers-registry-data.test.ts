import { describe, expect, test } from 'bun:test';

import { HttpClient, REGISTRY_VERSION } from '@lostgradient/weft';

import { rejectionOf } from '../../../testing/promise-outcome.test-support.ts';
import { registrySnapshot } from './contract-verification.test-support.ts';
import { MalformedRegistrySnapshotError } from './registry-snapshot-guard.ts';
import { loadRegistrySnapshot } from './workers-data.ts';

function clientReturning(value: unknown, inputs: unknown[] = []): HttpClient {
  const client = new HttpClient({ baseUrl: 'http://localhost' });
  Object.defineProperty(client, 'operations', {
    value: {
      'weft.system.registry': (input: unknown) => {
        inputs.push(input);
        return Promise.resolve(value);
      },
    },
  });
  return client;
}

describe('registry snapshot for contract verification', () => {
  test('reads weft.system.registry with an empty input', async () => {
    const inputs: unknown[] = [];
    const snapshot = registrySnapshot();
    const loaded = await loadRegistrySnapshot(clientReturning(snapshot, inputs));

    // Passed through whole: the Registry tab shares this query key.
    expect(loaded).toBe(snapshot);
    expect(inputs).toEqual([{}]);
  });

  test('rejects a snapshot whose verified fields are malformed', async () => {
    const malformed = [
      null,
      { ...registrySnapshot(), registryVersion: '2' },
      { ...registrySnapshot(), workflows: {} },
      { ...registrySnapshot(), workflows: [{ name: 'checkout' }] },
      { ...registrySnapshot(), activeRevisions: { checkout: 2 } },
      { ...registrySnapshot(), activities: [] },
    ];
    for (const value of malformed) {
      expect(await rejectionOf(loadRegistrySnapshot(clientReturning(value)))).toBeInstanceOf(
        MalformedRegistrySnapshotError,
      );
    }
  });

  test('rejects a snapshot with two manifests for one (name, revision)', async () => {
    const snapshot = registrySnapshot();
    const duplicated = { ...snapshot, workflows: [...snapshot.workflows, snapshot.workflows[1]!] };

    expect(await rejectionOf(loadRegistrySnapshot(clientReturning(duplicated)))).toBeInstanceOf(
      MalformedRegistrySnapshotError,
    );
  });

  test('accepts an active pointer with no manifest in this process (WFT-11)', async () => {
    // `engine.workflows.activate()` can activate an installed revision the
    // serving process has no in-process manifest for; codegen omits it too.
    const snapshot = {
      ...registrySnapshot(),
      activeRevisions: { ...registrySnapshot().activeRevisions, refund: 'refund-rev-2' },
    };

    expect(await loadRegistrySnapshot(clientReturning(snapshot))).toBe(snapshot);
  });

  test('accepts only the registry wire version this build understands', async () => {
    for (const registryVersion of [REGISTRY_VERSION - 1, REGISTRY_VERSION + 1]) {
      const snapshot = { ...registrySnapshot(), registryVersion };
      expect(await rejectionOf(loadRegistrySnapshot(clientReturning(snapshot)))).toBeInstanceOf(
        MalformedRegistrySnapshotError,
      );
    }
  });

  test('rejects a manifest whose contract changed under its supplied contract hash', async () => {
    // The supplied hash still equals a worker's advertised one; only the
    // canonical parser's recomputation notices the contract moved.
    const snapshot = registrySnapshot();
    const [old, active, refund] = snapshot.workflows;
    const tampered = {
      ...snapshot,
      workflows: [
        old!,
        { ...active!, contract: { ...active!.contract, activities: { charge: {} } } },
        refund!,
      ],
    };

    expect(await rejectionOf(loadRegistrySnapshot(clientReturning(tampered)))).toBeInstanceOf(
      MalformedRegistrySnapshotError,
    );
  });

  test('rejects a manifest the canonical parser refuses', async () => {
    const snapshot = registrySnapshot();
    const unsupported = {
      ...snapshot,
      workflows: [
        { ...snapshot.workflows[0]!, manifestVersion: 99 },
        ...snapshot.workflows.slice(1),
      ],
    };

    expect(await rejectionOf(loadRegistrySnapshot(clientReturning(unsupported)))).toBeInstanceOf(
      MalformedRegistrySnapshotError,
    );
  });
});
