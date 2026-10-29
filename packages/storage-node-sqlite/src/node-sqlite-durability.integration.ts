/**
 * The WAL, batch-atomicity, and mid-transaction-kill durability suites against `NodeSQLiteStorage`,
 * run under `node --test` with `test/register-bun-test-shim.ts` imported, because `better-sqlite3`
 * loads only under Node. The spec is passed unconditionally: a driver that does not load fails these
 * cases rather than registering none. `node-sqlite.test.ts` launches this file and asserts the count.
 */
import {
  describeBatchAtomicitySuite,
  describeWalDurabilitySuite,
  runMidTransactionKillSuite,
} from '@lostgradient/storage/testing';
import { nodeSqliteSpec } from './test/node-sqlite-spec.ts';

describeWalDurabilitySuite([nodeSqliteSpec]);
describeBatchAtomicitySuite([nodeSqliteSpec]);
await runMidTransactionKillSuite([nodeSqliteSpec], [nodeSqliteSpec]);
