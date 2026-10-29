# @lostgradient/storage-indexeddb

The IndexedDB storage adapter. `IndexedDBStorage` is a `Storage` over an IndexedDB object store, for browser tabs and service workers. It keeps every key in one `'kv'` object store, commits a batch in one read-write transaction, and reads large scans one buffered page at a time. Its only dependency is `@lostgradient/storage`, and the package never touches Node, Bun, or the filesystem, so it loads in any environment that has the `indexedDB` and `IDBKeyRange` globals.

| Entry                             | What it holds       |
| --------------------------------- | ------------------- |
| `@lostgradient/storage-indexeddb` | `IndexedDBStorage`. |

## Open a database

Pass a database name; it defaults to `'weft'`. The constructor starts opening the database, and every operation awaits that open, so you can use the storage immediately. Disposing it closes the database.

```ts
import { IndexedDBStorage } from '@lostgradient/storage-indexeddb';

await using storage = new IndexedDBStorage('app-state');
const encoder = new TextEncoder();

await storage.batch([
  { type: 'put', key: 'app:orders:1', value: encoder.encode('open') },
  { type: 'put', key: 'app:orders:2', value: encoder.encode('shipped') },
]);

const keys: string[] = [];
for await (const key of storage.keys('app:orders:')) keys.push(key);
console.log(keys); // ['app:orders:1', 'app:orders:2']
```

Outside a browser, or under a test, pass the runtime globals as the second argument instead of relying on `globalThis`.

```ts
import { IndexedDBStorage } from '@lostgradient/storage-indexeddb';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';

await using storage = new IndexedDBStorage('test-database', { indexedDB, IDBKeyRange });
await storage.put('app:greeting', new TextEncoder().encode('hello'));
```

## Scan consistency

`capabilities().scanConsistency` is `'best-effort'`. `scan()` and `keys()` read one page of rows inside a single read-only transaction, buffer it, and only then yield to your loop. No cursor or transaction stays open while your loop body runs, so the body can await any work without a `TransactionInactiveError`. The next page is read in a new transaction that resumes after the last row the previous page scanned, so a write between pages can appear in the iteration, and a record is never yielded twice. The page size is an internal constant, not an option.

## Hand it to Weft or Bureau

Weft and Bureau take a `Storage` you construct. Pass this one to `new Engine({ storage })` from `@lostgradient/weft`, or to Bureau's `storage` option. Weft's service worker constructs one when you give it no storage of its own.

## Test it

The package runs the shared contract from `@lostgradient/storage/testing` against `IndexedDBStorage` over `fake-indexeddb` (its `bunfig.toml` preloads `fake-indexeddb/auto`), plus characterization, fault-path, and scan-paging tests. `bun run test:coverage` fails below the line and function coverage of its own files that they had under Weft's coverage run before they moved here.

`src/indexeddb-browser.test.ts` drives a real Chromium through Playwright. It is opt-in, because a browser launch competes for the machine's CPU: run `bunx playwright install chromium` once, then `bun run --filter=@lostgradient/storage-indexeddb test:browser`, which sets `WEFT_BROWSER_SMOKE=1`. Without the variable the suite is skipped.
