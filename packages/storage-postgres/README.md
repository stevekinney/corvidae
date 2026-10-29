# @lostgradient/storage-postgres

The Postgres storage adapter. `PostgresStorage` is a `Storage` over a standard Postgres server, spoken to through the `pg` (node-postgres) driver. It keeps every key in one `kv(key TEXT COLLATE "C", value BYTEA)` table, commits a batch in one `SERIALIZABLE` transaction (retrying serialization failures), and reports `readAfterWrite: 'linearizable'`, which holds for a primary endpoint. The SQL it runs lives in `@lostgradient/storage/sql`, shared with the Neon adapter; this package supplies the `pg` pool and nothing else. Its dependencies are `@lostgradient/storage` and `pg`.

| Entry                            | What it holds                                   |
| -------------------------------- | ----------------------------------------------- |
| `@lostgradient/storage-postgres` | `PostgresStorage` and `PostgresStorageOptions`. |

## Connect to a server

Pass a connection URL. The `pg` driver loads on first use, and the storage closes the pool it created when it is disposed.

```ts
import { PostgresStorage } from '@lostgradient/storage-postgres';

await using storage = new PostgresStorage({
  url: 'postgresql://user:password@localhost:5432/app',
});
const encoder = new TextEncoder();

await storage.batch([
  { type: 'put', key: 'app:orders:1', value: encoder.encode('open') },
  { type: 'put', key: 'app:orders:2', value: encoder.encode('shipped') },
]);

const keys: string[] = [];
for await (const key of storage.keys('app:orders:')) keys.push(key);
console.log(keys); // ['app:orders:1', 'app:orders:2']
```

## Share a database

Point `schema` and `table` at names of your own to keep the store beside an application's tables.

```ts
import { PostgresStorage } from '@lostgradient/storage-postgres';

await using storage = new PostgresStorage({
  url: 'postgresql://user:password@localhost:5432/app',
  schema: 'weft',
  table: 'kv',
});
await storage.put('app:greeting', new TextEncoder().encode('hello'));
```

## Share a pool

Pass a `pool` (anything shaped like a `pg.Pool`) to reuse an application's connections. The caller owns an injected pool, so disposing the storage leaves it open.

## Hand it to Weft or Bureau

Weft and Bureau take a `Storage` you construct. Pass this one to `new Engine({ storage })` from `@lostgradient/weft`, or to Bureau's `storage` option.

## Test it

The package runs the shared contract from `@lostgradient/storage/testing` against `PostgresStorage` over PGlite, and a live suite against a real server through `@lostgradient/testing/postgres-server`. The live suite uses the server that `WEFT_TEST_POSTGRES_URL` names, or starts a disposable cluster when `initdb` and `pg_ctl` are on `PATH`, and skips only when neither exists. `bun run test:coverage` fails below full line and function coverage of its own files. `bun run test:benchmarks` measures how the deployment binding stamp behaves under Postgres `SERIALIZABLE` and needs the same server.
