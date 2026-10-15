/**
 * The one storage interface every asset backend implements (COR-794).
 *
 * Its verbs are a string key/value store with compare-and-swap — the shape
 * of Weft's `ConditionalTextValueStore` — so the same interface backs a
 * bounded in-memory map and any durable Weft `Storage`, and operative's
 * fault engine (`createFaultEngine(...).wrapStorage`, which intercepts
 * `get`/`set`/`delete`/`conditionalBatch`) can inject failures into either
 * without an adapter. Storage is always injected: the service never chooses
 * a backend or a vendor API itself.
 *
 * Bytes are stored once per digest, base64-encoded, under
 * `asset:v1:blob:<digest>`; every other key holds JSON metadata. See
 * `records.ts` for the key schema.
 */
import type { Storage } from '@lostgradient/weft';
import { textValueStore } from '@lostgradient/weft';

import { AssetStorageCapacityError } from './errors';

export interface AssetStorageCondition {
  readonly key: string;
  /** The required current value, or `null` to require the key to be absent. */
  readonly expectedValue: string | null;
}

export type AssetStorageOperation =
  | { readonly type: 'set'; readonly key: string; readonly value: string }
  | { readonly type: 'delete'; readonly key: string };

export interface AssetStorage {
  /** `durable` survives a process restart; `process-local` does not. */
  readonly durability: 'process-local' | 'durable';
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key starting with `prefix`, in ascending order. */
  list(prefix: string): Promise<string[]>;
  /** Applies `operations` atomically only when every condition holds; resolves `false` otherwise. */
  conditionalBatch(
    conditions: readonly AssetStorageCondition[],
    operations: readonly AssetStorageOperation[],
  ): Promise<boolean>;
}

export interface MemoryAssetStorageOptions {
  /** Upper bound on stored key and value characters. Defaults to 64 MiB. */
  readonly maxBytes?: number | undefined;
}

const DEFAULT_MEMORY_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The bounded, process-local backend. A write that would take the stored
 * total past `maxBytes` throws {@link AssetStorageCapacityError} and changes
 * nothing.
 */
export function createMemoryAssetStorage(options: MemoryAssetStorageOptions = {}): AssetStorage {
  const maxBytes = options.maxBytes ?? DEFAULT_MEMORY_MAX_BYTES;
  const entries = new Map<string, string>();
  let usedBytes = 0;

  const sizeOf = (key: string, value: string | undefined) =>
    value === undefined ? 0 : key.length + value.length;

  function apply(operations: readonly AssetStorageOperation[]): void {
    // Operations apply in order, so a key named twice is sized against its intermediate value.
    const pending = new Map<string, string | undefined>();
    let projected = usedBytes;
    for (const operation of operations) {
      const current = pending.has(operation.key)
        ? pending.get(operation.key)
        : entries.get(operation.key);
      const next = operation.type === 'set' ? operation.value : undefined;
      projected += sizeOf(operation.key, next) - sizeOf(operation.key, current);
      pending.set(operation.key, next);
    }
    if (projected > maxBytes) throw new AssetStorageCapacityError(maxBytes);
    for (const operation of operations) {
      if (operation.type === 'set') entries.set(operation.key, operation.value);
      else entries.delete(operation.key);
    }
    usedBytes = projected;
  }

  return {
    durability: 'process-local',
    get: async (key) => entries.get(key) ?? null,
    set: async (key, value) => apply([{ type: 'set', key, value }]),
    delete: async (key) => apply([{ type: 'delete', key }]),
    list: async (prefix) => [...entries.keys()].filter((key) => key.startsWith(prefix)).toSorted(),
    conditionalBatch: async (conditions, operations) => {
      for (const condition of conditions) {
        if ((entries.get(condition.key) ?? null) !== condition.expectedValue) return false;
      }
      apply(operations);
      return true;
    },
  };
}

/**
 * The durable backend over any Weft `Storage` that supports conditional
 * batches (SQLite, LMDB, ...). The caller owns `storage` and disposes it;
 * this adapter never closes it.
 */
export function createDurableAssetStorage(storage: Storage): AssetStorage {
  const text = textValueStore(storage, { disposeUnderlyingStorage: false });
  return {
    durability: 'durable',
    get: (key) => text.get(key),
    set: (key, value) => text.set(key, value),
    delete: (key) => text.delete(key),
    list: async (prefix) => {
      const keys = await text.list(prefix);
      return keys.toSorted();
    },
    conditionalBatch: (conditions, operations) =>
      text.conditionalBatch(
        conditions.map((condition) => ({ ...condition })),
        operations.map((operation) => ({ ...operation })),
      ),
  };
}
