/**
 * The shared `Storage` contract against `NodeSQLiteStorage`, run under `node --test` with
 * `test/register-bun-test-shim.ts` imported, because `better-sqlite3` loads only under Node.
 * `node-sqlite.test.ts` launches it with the other native cases and asserts their count.
 */
import {
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
  runConcurrentConditionalBatchConformance,
  runStorageCapabilityConformance,
} from '@lostgradient/storage/testing';
import { NodeSQLiteStorage } from './node-sqlite.ts';

const create = () => new NodeSQLiteStorage(':memory:');

runStorageCapabilityConformance('NodeSQLiteStorage', {
  create,
  expected: {
    persistence: 'ephemeral',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: false,
  },
});
runBasicStorageContract('NodeSQLiteStorage', { create });
runConcurrentConditionalBatchConformance('NodeSQLiteStorage', { create });
runBinaryAndLargeScanStorageConformance('NodeSQLiteStorage', { create });
