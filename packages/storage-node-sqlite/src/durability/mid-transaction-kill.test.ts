/**
 * Mid-transaction SIGKILL scenarios for `NodeSQLiteStorage`. The suite lives in
 * `@lostgradient/storage/testing`; this file runs it against the Node SQLite spec, which is offered
 * only where `better-sqlite3` loads (never under Bun).
 */
import { runMidTransactionKillSuite } from '@lostgradient/storage/testing';
import { availableNodeSqliteSpecs } from './node-sqlite-spec.test-support.ts';

await runMidTransactionKillSuite(availableNodeSqliteSpecs(), availableNodeSqliteSpecs());
