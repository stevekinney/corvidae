/**
 * Native-transaction batch atomicity for `BunSQLiteStorage`. The suite lives in
 * `@lostgradient/storage/testing`; this file runs it against the Bun SQLite spec.
 */
import { describeBatchAtomicitySuite } from '@lostgradient/storage/testing';
import { bunSqliteSpec } from './bun-sqlite-spec.test-support.ts';

describeBatchAtomicitySuite([bunSqliteSpec]);
