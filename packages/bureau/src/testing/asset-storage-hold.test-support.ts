/**
 * Holds one `AssetStorage` call so a test can run another writer between a read and the write
 * that depends on it (COR-1609): two Bureaus over one durable store, one parked mid-operation,
 * the other finishing first. The held Bureau's own storage is the one wrapped, because the
 * asset service reads and writes through `AssetStorage`, never the Weft store beneath it.
 */
import type { AssetStorage } from '../assets/storage';

type AssetStorageVerb = 'get' | 'set' | 'delete' | 'list' | 'conditionalBatch';

export interface AssetStorageHold {
  /** The storage to give the held Bureau. Nothing is held until `arm()`. */
  readonly storage: AssetStorage;
  /** Starts holding: the next matching call is the one held. */
  arm(): void;
  /** Resolves once a matching call is parked. */
  readonly reached: Promise<void>;
  /** Lets the parked call return. */
  release(): void;
}

/**
 * Holds the first call to `verb` whose first argument satisfies `matches`, after the call has
 * read what it reads (so the caller acts on a value that is stale by the time it resumes).
 */
export function holdAssetStorageCall(
  inner: AssetStorage,
  verb: Exclude<AssetStorageVerb, 'conditionalBatch'>,
  matches: (key: string) => boolean,
): AssetStorageHold {
  let armed = false;
  let held = false;
  const reached = Promise.withResolvers<void>();
  const open = Promise.withResolvers<void>();

  const wrapped: AssetStorage = {
    durability: inner.durability,
    get: async (key) => {
      const value = await inner.get(key);
      if (verb === 'get' && armed && !held && matches(key)) {
        held = true;
        reached.resolve();
        await open.promise;
      }
      return value;
    },
    set: (key, value) => inner.set(key, value),
    delete: (key) => inner.delete(key),
    list: async (prefix) => {
      const keys = await inner.list(prefix);
      if (verb === 'list' && armed && !held && matches(prefix)) {
        held = true;
        reached.resolve();
        await open.promise;
      }
      return keys;
    },
    conditionalBatch: (conditions, operations) => inner.conditionalBatch(conditions, operations),
  };

  return {
    storage: wrapped,
    arm: () => {
      armed = true;
    },
    reached: reached.promise,
    release: () => open.resolve(),
  };
}
