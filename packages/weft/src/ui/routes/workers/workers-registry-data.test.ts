import { describe, expect, test } from 'bun:test';

import { HttpClient } from '@lostgradient/weft';

import { rejectionOf } from '../../../testing/promise-outcome.test-support.ts';
import { registrySnapshot } from './contract-verification.test-support.ts';
import { MalformedRegistrySnapshotError } from './contract-verification.ts';
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
});
