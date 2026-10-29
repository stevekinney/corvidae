# @lostgradient/storage-node-sqlite

The Node SQLite storage adapter. `NodeSQLiteStorage` is a `Storage` over [better-sqlite3](https://github.com/WiseLibs/better-sqlite3): it opens the database in WAL mode, caches its prepared statements, commits a batch in one immediate transaction, and waits on another process's write lock instead of failing. It runs under Node.js 22 or later, loads the `better-sqlite3` driver on first construction, and does not load under Bun, whose own adapter is `@lostgradient/storage-bun-sqlite`. Its other dependency is `@lostgradient/storage`, which holds the protocol it implements.

| Entry                               | What it holds        |
| ----------------------------------- | -------------------- |
| `@lostgradient/storage-node-sqlite` | `NodeSQLiteStorage`. |

## Store bytes on disk

Pass a file path for storage that survives a restart, or leave it out (or pass `':memory:'`) for an ephemeral store. `capabilities().persistence` reports `'local'` for a file and `'ephemeral'` for memory, which is what `assertDurableStorageForRecovery()` in Weft reads.

```ts
import { NodeSQLiteStorage } from '@lostgradient/storage-node-sqlite';

using storage = new NodeSQLiteStorage('./app.sqlite');
const encoder = new TextEncoder();

await storage.batch([
  { type: 'put', key: 'app:orders:1', value: encoder.encode('open') },
  { type: 'put', key: 'app:orders:2', value: encoder.encode('shipped') },
]);

const keys: string[] = [];
for await (const [key] of storage.scan('app:orders:')) keys.push(key);
console.log(keys); // ['app:orders:1', 'app:orders:2']
```

## When the driver does not load

`better-sqlite3` is a native module. If it is missing, was never compiled (an install that suppressed lifecycle scripts), or is refused by the runtime, the constructor throws an error that names which of the three happened and the remedy: install it, rebuild it with `npm rebuild better-sqlite3`, or run under Node.js.

## Hand it to Weft or Bureau

Weft and Bureau take a `Storage` you construct. Pass this one to `new Engine({ storage })` from `@lostgradient/weft`, or to Bureau's `storage` option. Neither package depends on this one, so add `@lostgradient/storage-node-sqlite` to the package that constructs it.

## Test it

The package's tests run under Bun, which cannot load `better-sqlite3`. They exercise the adapter through an injected database constructor and the loader's error shaping, and `src/node-sqlite.test.ts` launches one real Node process (it fails without one) for everything that needs the driver:

- `src/node-sqlite-native.integration.ts`, the adapter's own native cases, including a two-process write race;
- `src/node-sqlite-contract.integration.ts`, the shared `Storage` contract from `@lostgradient/storage/testing`;
- `src/node-sqlite-durability.integration.ts`, the shared WAL, batch-atomicity, and mid-transaction-kill durability suites, over the adapter's spec in `src/test/node-sqlite-spec.ts`; the kill suite's children run under Node too;
- `src/test/bun-test-shim.integration.ts`, the shim's own cases.

The shared suites import `bun:test`, so the Node process is started with `--import src/test/register-bun-test-shim.ts`, which resolves `bun:test` to `src/test/bun-test-shim.ts`: the `describe`, `it`, hooks, and matchers those suites use, over `node:test` and `node:assert`, and an error for anything else. The launcher asserts the child's case count, that nothing was skipped, and that each shared suite registered. To run the Node cases by hand:

```sh
node --import ./src/test/register-bun-test-shim.ts --test src/*.integration.ts src/test/*.integration.ts
```

`bun run test:coverage` fails below full line and function coverage of the package's own files.
