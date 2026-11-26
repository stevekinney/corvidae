import { expect, test } from 'bun:test';

import { D1Storage, type D1Database } from './index.ts';

test('reports the D1 primary capability profile without touching the binding', () => {
  const database = {} as D1Database;
  expect(new D1Storage(database).capabilities()).toEqual({
    persistence: 'remote',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  });
});
