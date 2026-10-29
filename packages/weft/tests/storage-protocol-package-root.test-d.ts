// The storage protocol moved from Weft to `@lostgradient/storage` (COR-1766). These type-only
// assertions keep its types out of Weft's public entry point; `src/index.test.ts` checks the values.

// @ts-expect-error: `Storage` is exported by `@lostgradient/storage`, not Weft.
import type { Storage } from '@lostgradient/weft';
// @ts-expect-error: `BatchOperation` is exported by `@lostgradient/storage`, not Weft.
import type { BatchOperation } from '@lostgradient/weft';
// @ts-expect-error: `ScanOptions` is exported by `@lostgradient/storage`, not Weft.
import type { ScanOptions } from '@lostgradient/weft';
// @ts-expect-error: `ConditionalBatchCondition` is exported by `@lostgradient/storage`, not Weft.
import type { ConditionalBatchCondition } from '@lostgradient/weft';
// @ts-expect-error: `StorageCapabilities` is exported by `@lostgradient/storage`, not Weft.
import type { StorageCapabilities } from '@lostgradient/weft';
// @ts-expect-error: `TextValueStore` is exported by `@lostgradient/storage`, not Weft.
import type { TextValueStore } from '@lostgradient/weft';
// @ts-expect-error: `DeleteRangeOptions` is exported by `@lostgradient/storage`, not Weft.
import type { DeleteRangeOptions } from '@lostgradient/weft';
// @ts-expect-error: `PostgresPool` is exported by `@lostgradient/storage/sql`, not Weft.
import type { PostgresPool } from '@lostgradient/weft';
// @ts-expect-error: `MemoryStorage` is exported by `@lostgradient/storage`, not Weft.
import { KEYS, MemoryStorage } from '@lostgradient/weft';

export type MovedStorageTypes = [
  Storage,
  BatchOperation,
  ScanOptions,
  ConditionalBatchCondition,
  StorageCapabilities,
  TextValueStore,
  DeleteRangeOptions,
  PostgresPool,
];
void MemoryStorage;
void KEYS;
