import { describe, expect, it } from 'bun:test';

import type { StorageBackendDescriptor } from '../testing/storage-backends.test-support.ts';

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * Register the conditional-batch tests (commit on match, no writes on mismatch, `null` as
 * absence) for one storage backend.
 */
export function describeConditionalBatch(backend: StorageBackendDescriptor): void {
  describe(`${backend.name} conditional batch`, () => {
    it('commits a batch when every condition matches', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.conditionalBatch).toBeDefined();

        await storage.put('condition:match', encode('before'));

        const committed = await storage.conditionalBatch!(
          [{ key: 'condition:match', expectedValue: encode('before') }],
          [
            { type: 'put', key: 'condition:match', value: encode('after') },
            { type: 'put', key: 'condition:new', value: encode('created') },
          ],
        );

        expect(committed).toBe(true);
        expect(await storage.get('condition:match')).toEqual(encode('after'));
        expect(await storage.get('condition:new')).toEqual(encode('created'));
      } finally {
        cleanup();
      }
    });

    it('does not apply writes when a condition mismatches', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.conditionalBatch).toBeDefined();

        await storage.put('condition:match', encode('before'));

        const committed = await storage.conditionalBatch!(
          [{ key: 'condition:match', expectedValue: encode('stale') }],
          [{ type: 'put', key: 'condition:match', value: encode('after') }],
        );

        expect(committed).toBe(false);
        expect(await storage.get('condition:match')).toEqual(encode('before'));
      } finally {
        cleanup();
      }
    });

    it('treats null expected values as key absence', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.conditionalBatch).toBeDefined();

        const committed = await storage.conditionalBatch!(
          [{ key: 'condition:missing', expectedValue: null }],
          [{ type: 'put', key: 'condition:missing', value: encode('created') }],
        );

        expect(committed).toBe(true);
        expect(await storage.get('condition:missing')).toEqual(encode('created'));
      } finally {
        cleanup();
      }
    });
  });
}
