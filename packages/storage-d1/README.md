# @lostgradient/storage-d1

`D1Storage` is a durable `Storage` adapter over a Cloudflare D1 binding. Run `migrate()` before using it; the migration is idempotent and safe on every Worker start.

```ts
import { D1Storage, migrate } from '@lostgradient/storage-d1';

await migrate(env.DB);
const storage = new D1Storage(env.DB);
```

## Persisted format

The D1 database owns two persisted tables: `storage_d1_kv(key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID` stores every key and its raw bytes, while `storage_d1_expectation_guard(value INTEGER NOT NULL CHECK (value = 0))` stays empty and aborts a conditional batch when an expectation fails. These stable table names and columns are the adapter's persisted format; do not repurpose either table for application data.

Every read goes to the D1 primary binding. The adapter never uses a Sessions API bookmark or a read replica, so a completed write is visible to the following read and `readAfterWrite` is `'linearizable'`. Conditional batches place their expectation guard and all mutations in one D1 transaction: a failed expectation returns `false` and changes no touched row.
