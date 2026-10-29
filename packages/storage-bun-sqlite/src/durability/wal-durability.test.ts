/**
 * WAL-mode on-disk durability for `BunSQLiteStorage`. The suite lives in
 * `@lostgradient/storage/testing`; this file runs it against the Bun SQLite spec.
 */
import { describeWalDurabilitySuite } from '@lostgradient/storage/testing';
import { bunSqliteSpec } from './bun-sqlite-spec.test-support.ts';

describeWalDurabilitySuite([bunSqliteSpec]);
