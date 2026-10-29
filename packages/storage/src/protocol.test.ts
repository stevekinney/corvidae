import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { storageBatch, storageConditionalBatch } from './interface.ts';
import { MemoryStorage } from './memory.ts';

describe('storageBatch', () => {
  it('applies the operations through the adapter', async () => {
    await using storage = new MemoryStorage();
    await storageBatch(storage, [
      { type: 'put', key: 'a', value: new Uint8Array([1]) },
      { type: 'put', key: 'b', value: new Uint8Array([2]) },
      { type: 'delete', key: 'a' },
    ]);
    expect(await storage.get('a')).toBeNull();
    expect(await storage.get('b')).toEqual(new Uint8Array([2]));
  });
});

describe('storageConditionalBatch', () => {
  it('refuses an adapter that reports conditionalBatch but lacks the method', async () => {
    await using memory = new MemoryStorage();
    const storage = { capabilities: () => memory.capabilities() };
    const error = await rejectionOf(storageConditionalBatch(storage, [], []));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'This storage backend reports conditionalBatch capability but does not implement the conditionalBatch() method.',
    );
  });
});
