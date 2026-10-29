# @lostgradient/storage-bun-sqlite

The Bun SQLite storage adapter. `BunSQLiteStorage` is a `Storage` over Bun's built-in `bun:sqlite`: it opens the database in WAL mode, caches its prepared statements, commits a batch in one transaction, and waits on another process's write lock instead of failing. It needs the Bun runtime and carries no database driver of its own; its only dependency is `@lostgradient/storage`, which holds the protocol it implements.

| Entry                              | What it holds       |
| ---------------------------------- | ------------------- |
| `@lostgradient/storage-bun-sqlite` | `BunSQLiteStorage`. |

## Store bytes on disk

Pass a file path for storage that survives a restart, or leave it out (or pass `':memory:'`) for an ephemeral store. `capabilities().persistence` reports `'local'` for a file and `'ephemeral'` for memory, which is what `assertDurableStorageForRecovery()` in Weft reads.

```ts
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';

using storage = new BunSQLiteStorage('./app.sqlite');
const encoder = new TextEncoder();

await storage.batch([
  { type: 'put', key: 'app:orders:1', value: encoder.encode('open') },
  { type: 'put', key: 'app:orders:2', value: encoder.encode('shipped') },
]);

const keys: string[] = [];
for await (const key of storage.keys('app:orders:')) keys.push(key);
console.log(keys); // ['app:orders:1', 'app:orders:2']
```

## Read the database

`query` runs one read-only `SELECT` or `PRAGMA` statement against the database, for dashboards and debugging. Any statement that writes is rejected.

```ts
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';

using storage = new BunSQLiteStorage();

const rows = await storage.query<{ journal_mode: string }>('PRAGMA journal_mode');
console.log(rows[0]?.journal_mode); // 'memory' for an in-memory database, 'wal' for a file
```

## Hand it to Weft or Bureau

Weft and Bureau take a `Storage` you construct. Pass this one to `new Engine({ storage })` from `@lostgradient/weft`, or to Bureau's `storage` option.

## Test it

The package runs the shared contract from `@lostgradient/storage/testing` against `BunSQLiteStorage`, the two-process write race, and the WAL, batch-atomicity, and mid-transaction-kill durability suites with the adapter's own spec (`src/durability/bun-sqlite-spec.test-support.ts`). `bun run test:coverage` fails below full line and function coverage of its own files.
