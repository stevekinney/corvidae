# @lostgradient/storage-turso

The Turso storage adapter. `TursoStorage` is a `Storage` over a libSQL database, spoken to through the `@libsql/client` driver: a local `file:` database, an in-memory one, or a remote Turso instance (`libsql://`). It keeps every key in one SQLite key-value table, commits a batch in one write transaction (retrying `SQLITE_BUSY` and `SQLITE_LOCKED`), and reports `readAfterWrite: 'session'`, the floor that also covers a remote primary. The SQL it runs lives in `@lostgradient/storage/sql`, shared with the SQLite adapters; this package supplies the libSQL client and nothing else. Its dependencies are `@lostgradient/storage` and `@libsql/client`.

| Entry                         | What it holds                             |
| ----------------------------- | ----------------------------------------- |
| `@lostgradient/storage-turso` | `TursoStorage` and `TursoStorageOptions`. |

## Connect to a database

Pass a database URL. The driver loads on first use, not at construction, so importing the package never requires `@libsql/client` to resolve; only the first operation does. The storage closes the client it created when it is disposed.

```ts
import { TursoStorage } from '@lostgradient/storage-turso';

await using storage = new TursoStorage({ url: 'file:local.db' });
const encoder = new TextEncoder();

await storage.batch([
  { type: 'put', key: 'app:orders:1', value: encoder.encode('open') },
  { type: 'put', key: 'app:orders:2', value: encoder.encode('shipped') },
]);

const keys: string[] = [];
for await (const key of storage.keys('app:orders:')) keys.push(key);
console.log(keys); // ['app:orders:1', 'app:orders:2']
```

`capabilities().persistence` reports `'ephemeral'` for `file::memory:`, `'local'` for any other `file:` URL, and `'remote'` otherwise.

## Connect to Turso

Pass the database's `libsql://` URL and its token.

```ts
import { TursoStorage } from '@lostgradient/storage-turso';

await using storage = new TursoStorage({
  url: 'libsql://my-db.turso.io',
  authToken: 'token-from-your-secret-store',
});
await storage.put('app:greeting', new TextEncoder().encode('hello'));
```

## Hand it to Weft or Bureau

Weft and Bureau take a `Storage` you construct. Pass this one to `new Engine({ storage })` from `@lostgradient/weft`, or to Bureau's `storage` option.

## Test it

The package runs the shared contract from `@lostgradient/storage/testing` against `TursoStorage` over local libSQL files, the three durability suites (WAL, batch atomicity, mid-transaction kill) with Turso's spec, and the driver-deferral regression (COR-1230): a subprocess in a sandbox without `@libsql/client` constructs a `TursoStorage` and only fails at its first operation. `bun run test:coverage` fails below the line and function coverage of its own files that they had under Weft's coverage run before they moved here.
