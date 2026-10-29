import {
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
  runStorageCapabilityConformance,
} from '@lostgradient/storage/testing';
import { WebExtensionStorage } from './web-extension.ts';

/**
 * A promise-style `browser.storage` area over a `Map`, the shape the adapter drives. Each
 * `create()` below builds its own namespace and hands it to the constructor, so no case shares
 * state with another and nothing is installed on `globalThis`.
 */
function createInjectedStorage(): WebExtensionStorage {
  const data = new Map<string, unknown>();
  const area = {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const result: Record<string, unknown> = {};
      const selected = keys === undefined || keys === null ? [...data.keys()] : [keys].flat();
      for (const key of selected) {
        if (data.has(key)) result[key] = data.get(key);
      }
      return Promise.resolve(result);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const key of [keys].flat()) data.delete(key);
      return Promise.resolve();
    },
  };
  const namespace = {
    storage: {
      local: area,
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  return new WebExtensionStorage({ area: 'local' }, namespace);
}

runStorageCapabilityConformance('WebExtensionStorage', {
  create: createInjectedStorage,
  expected: {
    persistence: 'local',
    readAfterWrite: 'session',
    scanConsistency: 'best-effort',
    atomicBatch: false,
    conditionalBatch: false,
    boundedRangeDelete: false,
  },
});
runBasicStorageContract('WebExtensionStorage', { create: createInjectedStorage });
runBinaryAndLargeScanStorageConformance('WebExtensionStorage', {
  create: createInjectedStorage,
  largeScanTimeoutMs: 30_000,
});
