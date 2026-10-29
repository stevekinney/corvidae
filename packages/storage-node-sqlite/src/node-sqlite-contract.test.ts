/**
 * The shared `Storage` contract against `NodeSQLiteStorage`. The runners register `bun:test` suites
 * and `better-sqlite3` loads only under Node, so, as with the durability specs, the suites are
 * registered only where the adapter opens; under Bun the native cases run in
 * `node-sqlite-native.integration.ts`, which `node-sqlite.test.ts` launches in a Node process.
 */
import {
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
  runConcurrentConditionalBatchConformance,
  runStorageCapabilityConformance,
} from '@lostgradient/storage/testing';
import { availableNodeSqliteSpecs } from './durability/node-sqlite-spec.test-support.ts';
import { NodeSQLiteStorage } from './node-sqlite.ts';

if (availableNodeSqliteSpecs().length > 0) {
  runStorageCapabilityConformance('NodeSQLiteStorage', {
    create: () => new NodeSQLiteStorage(':memory:'),
    expected: {
      persistence: 'ephemeral',
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: false,
    },
  });
  runBasicStorageContract('NodeSQLiteStorage', { create: () => new NodeSQLiteStorage(':memory:') });
  runConcurrentConditionalBatchConformance('NodeSQLiteStorage', {
    create: () => new NodeSQLiteStorage(':memory:'),
  });
  runBinaryAndLargeScanStorageConformance('NodeSQLiteStorage', {
    create: () => new NodeSQLiteStorage(':memory:'),
  });
}
