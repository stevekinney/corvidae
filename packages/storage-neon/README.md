# @lostgradient/storage-neon

The Neon storage adapter. `NeonStorage` is a `Storage` over Neon serverless Postgres, spoken to through the `@neondatabase/serverless` driver. It keeps every key in one `kv(key TEXT COLLATE "C", value BYTEA)` table, commits a batch in one `SERIALIZABLE` transaction (retrying serialization failures), and reports `readAfterWrite: 'linearizable'`, which holds for a primary endpoint. The SQL it runs lives in `@lostgradient/storage/sql`, shared with the Postgres adapter; this package supplies the Neon pool and nothing else. Its dependencies are `@lostgradient/storage` and `@neondatabase/serverless`.

| Entry                        | What it holds                           |
| ---------------------------- | --------------------------------------- |
| `@lostgradient/storage-neon` | `NeonStorage` and `NeonStorageOptions`. |

## Connect to a database

Pass a connection URL. The driver loads on first use, and the storage closes the pool it created when it is disposed. Point the URL at the primary endpoint: a read-replica connection string would break the linearizable read-after-write guarantee.

```ts
import { NeonStorage } from '@lostgradient/storage-neon';

await using storage = new NeonStorage({
  url: 'postgresql://user:password@ep-cool-name.us-east-2.aws.neon.tech/app?sslmode=require',
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

The driver connects over WebSocket. Bun and Node 22 or later provide a global `WebSocket`; on Node 21 or earlier, set `neonConfig.webSocketConstructor` to the `ws` package before the first use.

## Share a database

Point `schema` and `table` at names of your own to keep the store beside an application's tables.

```ts
import { NeonStorage } from '@lostgradient/storage-neon';

await using storage = new NeonStorage({
  url: 'postgresql://user:password@ep-cool-name.us-east-2.aws.neon.tech/app?sslmode=require',
  schema: 'weft',
  table: 'kv',
});
await storage.put('app:greeting', new TextEncoder().encode('hello'));
```

## Share a pool

Pass a `pool` (anything shaped like a Neon `Pool`) to reuse an application's connections. The caller owns an injected pool, so disposing the storage leaves it open.

## Hand it to Weft or Bureau

Weft and Bureau take a `Storage` you construct. Pass this one to `new Engine({ storage })` from `@lostgradient/weft`, or to Bureau's `storage` option.

## Test it

The package runs the shared contract from `@lostgradient/storage/testing` against `NeonStorage` over PGlite, and a live suite that drives the real Neon driver against a real server through a WebSocket proxy (`createNeonTestProxy`). The live suite uses the server that `WEFT_TEST_POSTGRES_URL` names (read by `@lostgradient/testing/postgres-server`), or starts a disposable cluster when `initdb` and `pg_ctl` are on `PATH`, and skips only when neither exists. `bun run test:coverage` fails below full line and function coverage of its own files.
