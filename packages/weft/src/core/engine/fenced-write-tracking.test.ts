import { describe, expect, it } from 'bun:test';

import type { Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from '../engine.ts';
import { workflow } from '../types.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import { getInternals } from './internals.ts';

describe('commitFencedEngineWrite write tracking', () => {
  it("tracks only the storage write, not a lost CAS's epoch re-read under ownership: 'lease'", async () => {
    // Async disposal waits on tracked purge writes. If the tracked promise also
    // covered the re-read that tells a lost race from a deposition, a storage
    // read that never returns would hold disposal and the lease release.
    const engine = await Engine.create({
      storage: new MemoryStorage(),
      workflows: {
        'fenced-write-tracking-noop': workflow({ name: 'fenced-write-tracking-noop' }).execute(
          async function* () {
            return null;
          },
        ),
      },
      ownership: 'lease',
    });
    const internals = getInternals(engine);
    const base = internals.storage;
    let rereadArmed = false;
    const rereadReached = Promise.withResolvers<void>();
    const releaseReread = Promise.withResolvers<void>();
    internals.storage = {
      capabilities: () => base.capabilities(),
      get: async (key) => {
        if (rereadArmed && key === KEYS.leaseEpoch()) {
          rereadReached.resolve();
          await releaseReread.promise;
        }
        return base.get(key);
      },
      put: (key, value) => base.put(key, value),
      delete: (key) => base.delete(key),
      scan: (prefix, options) => base.scan(prefix, options),
      batch: (operations) => base.batch(operations),
      // Lose the CAS without a deposition: the epoch still matches on re-read.
      conditionalBatch: async () => {
        rereadArmed = true;
        return false;
      },
      [Symbol.dispose]: () => base[Symbol.dispose](),
    } satisfies Storage;

    const tracked: Promise<unknown>[] = [];
    const commit = commitFencedEngineWrite(
      internals,
      null,
      [{ type: 'put', key: 'k', value: new Uint8Array([1]) }],
      [],
      () => new Error('lost race'),
      (write) => {
        tracked.push(write);
        return write;
      },
    );
    await rereadReached.promise;

    expect(tracked).toHaveLength(1);
    expect(await Promise.allSettled(tracked)).toEqual([{ status: 'fulfilled', value: false }]);

    rereadArmed = false;
    releaseReread.resolve();
    await expect(commit).rejects.toThrow('lost race');

    internals.storage = base;
    await engine[Symbol.asyncDispose]();
  });
});
