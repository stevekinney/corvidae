# @lostgradient/storage-cloudflare

The Cloudflare Durable Object SQLite storage adapter. `CloudflareDurableObjectSQLiteStorage` is a `Storage` over a Durable Object's `ctx.storage.sql` binding. It keeps every key in one SQLite key-value table, commits a batch with no `await` between its statements (Durable Object storage is transactional up to the next yield point), and deletes a prefix or a bounded range with one native `DELETE`. The package imports no Cloudflare type package and no runtime-specific module: the `sql` binding is injected by the caller and typed by the structural `Sql` interface, so the adapter bundles for Bun, Node, and `workerd` alike. Its only dependency is `@lostgradient/storage`.

| Entry | What it holds |
| --- | --- |
| `@lostgradient/storage-cloudflare` | `CloudflareDurableObjectSQLiteStorage`, its options, and the types `Sql`, `SqlStorageCursor`, `SqlStorageValue`, and `CloudflareValueEncoding`. |

## Wrap a Durable Object's SQL binding

Pass `ctx.storage.sql` from inside a `DurableObject` subclass. The adapter creates its table on construction and never closes the binding, so disposing the storage is a no-op.

```ts
import { CloudflareDurableObjectSQLiteStorage, type Sql } from '@lostgradient/storage-cloudflare';

// Injected by the Durable Object runtime: `ctx.storage.sql`.
declare const sql: Sql;

await using storage = new CloudflareDurableObjectSQLiteStorage({ sql });
const encoder = new TextEncoder();

await storage.batch([
  { type: 'put', key: 'app:orders:1', value: encoder.encode('open') },
  { type: 'put', key: 'app:orders:2', value: encoder.encode('shipped') },
]);

const keys: string[] = [];
for await (const key of storage.keys('app:orders:')) keys.push(key);
console.log(keys); // ['app:orders:1', 'app:orders:2']
```

## Choose a table and a value encoding

`table` names the key-value table (default `'kv'`) and must be a strict SQL identifier. `valueEncoding` is `'base64'` by default, which stores values as base64 text and so needs only the TEXT, number, and null types the binding guarantees. `'blob'` stores raw `ArrayBuffer` values and avoids base64's roughly one-third expansion. The encoding is a per-table decision: reading a row written under the other encoding fails with a descriptive error, so give a table one encoding, or use a different table name for the other.

```ts
import { CloudflareDurableObjectSQLiteStorage, type Sql } from '@lostgradient/storage-cloudflare';

declare const sql: Sql;

const storage = new CloudflareDurableObjectSQLiteStorage({
  sql,
  table: 'app_state',
  valueEncoding: 'blob',
});
void storage;
```

## Hand it to Weft or Bureau

Weft and Bureau take a `Storage` you construct. Pass this one to `Engine.create({ storage })` from `@lostgradient/weft`, or to Bureau's `storage` option. A Durable Object has no host process to own background intervals, so run the engine with `backgroundTasks: 'manual'` and `startScheduler: false`, and call `engine.runMaintenance()` from the Durable Object alarm or a Worker Cron Trigger.

## Test it

The package runs the shared contract from `@lostgradient/storage/testing` against the adapter in both value encodings, over a `bun:sqlite`-backed double of the `Sql` binding (`src/cloudflare-durable-object-sql-test-double.test-support.ts`), plus adapter-level tests for the table name, the encodings, scan snapshots, batches, and conditional batches. `bun run test:coverage` fails below the line and function coverage of its own files that they had under Weft's coverage run before they moved here.
