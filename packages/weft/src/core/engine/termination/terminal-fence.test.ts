import { describe, expect, it } from 'bun:test';

import { KEYS, type BatchOperation } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { beginExecutionAttempt, recordExecutionAttemptIdentity } from '../execution-attempts.ts';
import type { EngineInternals } from '../internals.ts';
import {
  bytesEqual,
  captureTerminalFence,
  commitFencedTeardownBatch,
  warnUnknownRunIdentity,
  type TerminalFence,
} from './terminal-fence.ts';

const generation = new Uint8Array([1, 2, 3]);
const fence: TerminalFence = { identity: { generation, holderMarker: null } };

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
    await storage.put(KEYS.workflowGeneration('w'), generation);
    expect(await commitFencedTeardownBatch(internals, 'w', fence, put('a'), () => false)).toBe(
      true,
    );
    await storage.put(KEYS.workflowGeneration('w'), new Uint8Array([7]));
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

describe('captureTerminalFence', () => {
  const identity = { generation: new Uint8Array([3]), holderMarker: null };

  it('takes the identity of the attempt that launched the committing run', () => {
    const internals = { storage: new MemoryStorage() } as unknown as EngineInternals;
    beginExecutionAttempt(internals, 'w', 'token-a');
    recordExecutionAttemptIdentity(internals, 'w', 'token-a', identity);
    expect(captureTerminalFence(internals, 'w', 'token-a').identity).toBe(identity);
  });

  it('has no identity for another generation, an unknown run, or an attempt that never learned it', () => {
    const internals = { storage: new MemoryStorage() } as unknown as EngineInternals;
    expect(captureTerminalFence(internals, 'w', 'token-a').identity).toBeUndefined();
    beginExecutionAttempt(internals, 'w', 'token-a');
    expect(captureTerminalFence(internals, 'w', 'token-a').identity).toBeUndefined();
    recordExecutionAttemptIdentity(internals, 'w', 'token-a', identity);
    expect(captureTerminalFence(internals, 'w', 'token-b').identity).toBeUndefined();
  });
});

describe('warnUnknownRunIdentity', () => {
  it('reports a missing identity once per call and stays quiet when it is known', () => {
    const reports: unknown[][] = [];
    const report = (...args: unknown[]) => void reports.push(args);
    warnUnknownRunIdentity({ identity: undefined }, 'w', report);
    warnUnknownRunIdentity({ identity: { generation: null, holderMarker: null } }, 'w', report);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.[0]).toBe('terminal-teardown-fence');
    expect(reports[0]?.[2]).toBe('w');
  });
});
