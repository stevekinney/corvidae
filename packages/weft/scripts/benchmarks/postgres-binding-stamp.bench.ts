/**
 * COR-1582: the binding stamp must not make concurrent bindings abort each other on Postgres.
 *
 * Postgres and Neon run each `conditionalBatch` at `SERIALIZABLE` and give up after five `40001`
 * retries, and two transactions that write the same row conflict under SERIALIZABLE. A stamp that
 * every binding to a build writes would be one such row, so concurrent starts or enqueues on one
 * build would fail with no removal anywhere. The stamp is therefore 64 shards, and a binding
 * writes the one its own key hashes to (`worker/deployment-records.ts`).
 *
 * This measures N concurrent batches shaped like a start's create batch (own key absent, put own
 * key) against a disposable cluster: without any stamp (the control), with the real sharded stamp,
 * and with every binding writing one shard, which is what a single stamp row is. The adapter's
 * `SERIALIZABLE` compare-and-swap loses a few independent batches on a near-empty table whatever
 * is written, so the control is the yardstick: what the sharded stamp loses beyond it must be a
 * small fraction of what one shared row loses, so the test fails if the stamp is not sharded.
 *
 * The counts depend on how transactions interleave, which host load moves, so this measurement runs
 * through `test:benchmarks` rather than the default gate. The default suite keeps the deterministic
 * guard: `deployment-build-binding.test.ts` pins the shard function's values, which one shard fails.
 */
import { afterAll, describe, expect, it } from 'bun:test';

import {
  openPostgresTestDatabase,
  requireOpenedPostgresTestDatabase,
} from '@lostgradient/testing/postgres-server';
import { PostgresStorage } from '../../src/storage/postgres.ts';
import {
  bindingStampKey,
  bindingStampShard,
  newBindingStamp,
} from '../../src/worker/deployment-records.ts';

const database = await openPostgresTestDatabase();
const ROUNDS = 8;

type Layout = 'control' | 'sharded' | 'single';

/** How many of `concurrent` start-shaped batches did not commit, summed over `ROUNDS` rounds. */
async function lost(storage: PostgresStorage, concurrent: number, layout: Layout): Promise<number> {
  let total = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    await storage.deletePrefix('');
    const outcomes = await Promise.all(
      Array.from({ length: concurrent }, (_, index) => {
        const key = `wf:${layout}-${concurrent}-${round}-${index}`;
        const stampShard = layout === 'single' ? 0 : bindingStampShard(key);
        return storage
          .conditionalBatch(
            [{ key, expectedValue: null }],
            [
              { type: 'put', key, value: new Uint8Array([index]) },
              ...(layout === 'control'
                ? []
                : [
                    {
                      type: 'put' as const,
                      key: bindingStampKey('deployment', 'build-1', stampShard),
                      value: newBindingStamp(),
                    },
                  ]),
            ],
          )
          .then(
            (applied) => applied,
            () => false,
          );
      }),
    );
    total += outcomes.filter((applied) => !applied).length;
  }
  return total;
}

describe.skipIf(database === null)('the binding stamp under Postgres SERIALIZABLE', () => {
  afterAll(() => requireOpenedPostgresTestDatabase(database)[Symbol.asyncDispose]());

  it.each([8, 24])(
    'adds far less loss than one shared row at %d concurrent bindings on one build',
    async (concurrent) => {
      const live = requireOpenedPostgresTestDatabase(database);
      await using storage = new PostgresStorage({ url: live.url, table: 'weft_stamp_contention' });
      await storage.put('__init__', new Uint8Array([0]));

      const control = await lost(storage, concurrent, 'control');
      const sharded = await lost(storage, concurrent, 'sharded');
      const single = await lost(storage, concurrent, 'single');
      console.log(JSON.stringify({ concurrent, rounds: ROUNDS, control, sharded, single }));

      // What each layout loses beyond the control. The adapter loses a few independent batches
      // whatever is written, and a sharded stamp adds the few pairs of bindings whose keys hash to
      // one shard; a single shared row adds far more. The sharded stamp must cost well under half
      // of what one shared row does, and the experiment must be able to tell the two apart.
      const shardedExcess = Math.max(0, sharded - control);
      const singleExcess = single - control;
      expect(singleExcess).toBeGreaterThan(concurrent / 2);
      expect(shardedExcess).toBeLessThanOrEqual(singleExcess * 0.4);
    },
  );
});
