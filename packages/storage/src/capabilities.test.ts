import { describe, expect, it } from 'bun:test';

import {
  assertDurableStorageForRecovery,
  requireStorageCapability,
  type StorageCapabilities,
} from './capabilities.ts';
import type { Storage } from './interface.ts';
import { MemoryStorage } from './memory.ts';

const durable: StorageCapabilities = {
  persistence: 'local',
  readAfterWrite: 'linearizable',
  scanConsistency: 'snapshot',
  atomicBatch: true,
  conditionalBatch: true,
  boundedRangeDelete: true,
};

function reporting(capabilities: StorageCapabilities): Storage {
  const storage = new MemoryStorage();
  return Object.assign(Object.create(storage) as Storage, { capabilities: () => capabilities });
}

describe('requireStorageCapability', () => {
  it('returns when the backend reports the capability', () => {
    expect(() =>
      requireStorageCapability(new MemoryStorage(), 'conditionalBatch', 'a feature'),
    ).not.toThrow();
  });

  it('names the feature when the backend reports the capability as missing', () => {
    const storage = reporting({ ...durable, conditionalBatch: false });
    expect(() => requireStorageCapability(storage, 'conditionalBatch', 'a feature')).toThrow(
      'a feature',
    );
  });
});

describe('assertDurableStorageForRecovery', () => {
  it('accepts local and remote durable backends', () => {
    expect(() => assertDurableStorageForRecovery(reporting(durable))).not.toThrow();
    expect(() =>
      assertDurableStorageForRecovery(reporting({ ...durable, persistence: 'remote' })),
    ).not.toThrow();
  });

  it('lists every axis that is too weak for recovery', () => {
    const storage = reporting({
      persistence: 'ephemeral',
      readAfterWrite: 'session',
      scanConsistency: 'best-effort',
      atomicBatch: false,
      conditionalBatch: false,
      boundedRangeDelete: false,
    });
    expect(() => assertDurableStorageForRecovery(storage)).toThrow(
      'Storage is not durable enough for recovery: persistence must be "local" or "remote" (got "ephemeral"); readAfterWrite must be "linearizable" (got "session"); scanConsistency must be "snapshot" (got "best-effort"); atomicBatch must be true; conditionalBatch must be true.',
    );
  });

  it('rejects memory storage, which does not outlive the process', () => {
    expect(() => assertDurableStorageForRecovery(new MemoryStorage())).toThrow(
      'persistence must be "local" or "remote" (got "ephemeral")',
    );
  });
});
