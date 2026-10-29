# @lostgradient/storage-lmdb

The LMDB storage adapter. `LMDBStorage` is a `Storage` over [lmdb-js](https://github.com/kriszyp/lmdb-js): a memory-mapped, single-writer store whose reads are synchronous, whose writes are batched into one transaction per commit, and whose scans read from a point-in-time snapshot. It needs Bun or Node.js and loads the `lmdb` driver on first construction; its other dependency is `@lostgradient/storage`, which holds the protocol it implements.

| Entry                        | What it holds                        |
| ---------------------------- | ------------------------------------ |
| `@lostgradient/storage-lmdb` | `LMDBStorage`, `LMDBStorageOptions`. |

## Store bytes on disk

`LMDBStorage` takes a directory path, which lmdb-js creates if it is missing. `capabilities().persistence` reports `'local'`, which is what `assertDurableStorageForRecovery()` in Weft reads.

```ts
import { LMDBStorage } from '@lostgradient/storage-lmdb';

using storage = new LMDBStorage('./app-data');
const encoder = new TextEncoder();

await storage.batch([
  { type: 'put', key: 'app:orders:1', value: encoder.encode('open') },
  { type: 'put', key: 'app:orders:2', value: encoder.encode('shipped') },
]);

const keys: string[] = [];
for await (const key of storage.keys('app:orders:')) keys.push(key);
console.log(keys); // ['app:orders:1', 'app:orders:2']
```

## Skip the fsync in tests

`durability: 'relaxed'` opens the environment with `noSync` and `noMetaSync`, so a commit does not wait for the disk. It is for test fixtures and other disposable stores: a crash can lose recent commits, so `capabilities().persistence` reports `'ephemeral'` and `assertDurableStorageForRecovery()` rejects it.

```ts
import { LMDBStorage } from '@lostgradient/storage-lmdb';

using storage = new LMDBStorage('./scratch-data', { durability: 'relaxed' });

console.log(storage.capabilities().persistence); // 'ephemeral'
```

## Hand it to Weft or Bureau

Weft and Bureau take a `Storage` you construct. Pass this one to `new Engine({ storage })` from `@lostgradient/weft`, or to Bureau's `storage` option. Neither package depends on this one, so add `@lostgradient/storage-lmdb` to the package that constructs it.

## Test it

The package runs the shared contract from `@lostgradient/storage/testing` against `LMDBStorage` (basic, capability, and binary and large-scan conformance), plus its own tests for non-ASCII key order, range safety, and the `lmdb.open` options it passes. `bun run test:coverage` fails below the line and function coverage these files had under Weft's coverage run before they moved.
