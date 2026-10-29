# @lostgradient/storage

The key-value storage protocol that Weft and its storage adapters share. It holds the `Storage` interface, the operations derived from it, the capability model, the in-memory and scoped stores, the text-value view, and the key and byte encodings that adapters persist. It has no dependency on Weft or on any database driver; each adapter is its own package and carries its own driver.

| Entry | What it holds |
| --- | --- |
| `@lostgradient/storage` | `Storage`, `BatchOperation`, `ScanOptions`, the `storage*` helpers, `MemoryStorage`, `ScopedStorage`, `textValueStore`, `copyTextKeyValueRowsToStorage`, the capability model, and the key and byte encodings. |
| `@lostgradient/storage/sql` | What the SQL adapters share: the SQLite and Postgres key-value queries, `PostgresKeyValueStorage` over any `PostgresPool`, the lazy driver pool, and the Neon batch and value mappings. |
| `@lostgradient/storage/runtime` | Storage's own loader for Node built-ins, `tryLoadNodeBuiltin`, with its test override. |
| `@lostgradient/storage/testing` | The contract runners every adapter's tests run, and the test support several storage packages share, including the durability suites. |
| `@lostgradient/storage/testing/sqlite-contention` | Only the SQLite contention support, for a test that runs under Node, which cannot load the `bun:test`-dependent `testing` entry. |

## Store and read bytes

Every adapter implements the same five core methods: `get`, `put`, `delete`, `scan`, and `batch`. Values are bytes, and keys sort by their UTF-8 code units.

```ts
import { MemoryStorage, storageBatch, storageKeys } from '@lostgradient/storage';

await using storage = new MemoryStorage();
const encoder = new TextEncoder();

await storageBatch(storage, [
  { type: 'put', key: 'app:orders:1', value: encoder.encode('open') },
  { type: 'put', key: 'app:orders:2', value: encoder.encode('shipped') },
]);

const keys: string[] = [];
for await (const key of storageKeys(storage, 'app:orders:')) keys.push(key);
console.log(keys); // ['app:orders:1', 'app:orders:2']
```

## Share one store between consumers

`scopedStorage` gives each consumer its own key namespace in one backing store. A text view reads and writes UTF-8 strings over the same bytes.

```ts
import { MemoryStorage, scopedStorage, textValueStore } from '@lostgradient/storage';

await using raw = new MemoryStorage();
const sessions = textValueStore(scopedStorage(raw, 'app:sessions'));

await sessions.set('user-1', 'active');
console.log(await sessions.get('user-1')); // 'active'
```

## Test an adapter

An adapter's tests run the shared contract against a fresh instance per case.

```ts
import { MemoryStorage } from '@lostgradient/storage';
import { runBasicStorageContract } from '@lostgradient/storage/testing';

runBasicStorageContract('MemoryStorage', { create: () => new MemoryStorage() });
```
