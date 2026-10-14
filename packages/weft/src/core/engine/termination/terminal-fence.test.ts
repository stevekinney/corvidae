import { describe, expect, it } from 'bun:test';

import { KEYS, type BatchOperation } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import type { EngineInternals } from '../internals.ts';
import {
  bytesEqual,
  commitFencedTeardownBatch,
  startHolderMarkerRead,
  type TerminalFence,
} from './terminal-fence.ts';

const fence: TerminalFence = {
  committedState: new Uint8Array([1, 2, 3]),
  holderMarker: Promise.resolve(null),
};

/** A storage that reports no `conditionalBatch` capability, like a custom adapter without CAS. */
function storageWithoutConditionalBatch(): MemoryStorage {
  const storage = new MemoryStorage();
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'capabilities') {
        return () => ({ ...target.capabilities(), conditionalBatch: false });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const put = (key: string): BatchOperation[] => [{ type: 'put', key, value: new Uint8Array([9]) }];

describe('commitFencedTeardownBatch', () => {
  it('without conditionalBatch, applies the batch while the same-engine guard holds', async () => {
    const storage = storageWithoutConditionalBatch();
    const internals = { storage } as unknown as EngineInternals;
    expect(await commitFencedTeardownBatch(internals, 'w', fence, put('k'), () => false)).toBe(
      true,
    );
    expect(await storage.get('k')).not.toBeNull();
  });

  it('without conditionalBatch, skips the batch once the same-engine guard reports a replacement', async () => {
    const storage = storageWithoutConditionalBatch();
    const internals = { storage } as unknown as EngineInternals;
    expect(await commitFencedTeardownBatch(internals, 'w', fence, put('k'), () => true)).toBe(
      false,
    );
    expect(await storage.get('k')).toBeNull();
  });

  it('with conditionalBatch, applies only while the committed state is still stored', async () => {
    const storage = new MemoryStorage();
    const internals = { storage } as unknown as EngineInternals;
    await storage.put(KEYS.workflow('w'), fence.committedState);
    expect(await commitFencedTeardownBatch(internals, 'w', fence, put('a'), () => false)).toBe(
      true,
    );
    await storage.put(KEYS.workflow('w'), new Uint8Array([7]));
    expect(await commitFencedTeardownBatch(internals, 'w', fence, put('b'), () => false)).toBe(
      false,
    );
    expect(await storage.get('b')).toBeNull();
  });
});

describe('bytesEqual', () => {
  it('compares contents and treats null as an absent key', () => {
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([2]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(bytesEqual(null, null)).toBe(true);
    expect(bytesEqual(null, new Uint8Array())).toBe(false);
  });
});

describe('startHolderMarkerRead', () => {
  it('hands back the read, and a failed read is still observed by the caller', async () => {
    const failure = new Error('read failed');
    const internals = {
      storage: { get: () => Promise.reject(failure) },
    } as unknown as EngineInternals;
    const read = startHolderMarkerRead(internals, 'w');
    expect(await read.catch((error: unknown) => error)).toBe(failure);

    const present = new MemoryStorage();
    await present.put(KEYS.workflowConcurrencyHolder('w'), new Uint8Array([4]));
    const stored = startHolderMarkerRead({ storage: present } as unknown as EngineInternals, 'w');
    expect(await stored).toEqual(new Uint8Array([4]));
  });
});
