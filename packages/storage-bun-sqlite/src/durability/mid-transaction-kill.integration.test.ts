/**
 * Mid-transaction SIGKILL scenarios for `BunSQLiteStorage`. The suite lives in
 * `@lostgradient/storage/testing`; this file runs it against the Bun SQLite spec.
 */
import { runMidTransactionKillSuite } from '@lostgradient/storage/testing';
import { bunSqliteSpec } from './bun-sqlite-spec.test-support.ts';

await runMidTransactionKillSuite([bunSqliteSpec], [bunSqliteSpec]);
