/**
 * COR-2009 — the Bureau's own stores, opened over a storage no Bureau is running on, so a fixture
 * can write records the way the Bureau writes them (`@lostgradient/bureau/testing`).
 *
 * A fixture uses this to seed what a live Bureau must not do for it: the showcase's hook
 * deliveries are written as records with the times the sample world gives them and are never sent
 * to the real addresses its hooks name. Each record goes through the store's own write, so its
 * keys, its index entries and its conditional revision are what the Bureau would have written.
 *
 * Open the stores only while no Bureau runs on the same storage: a running Bureau holds leases on
 * pending deliveries and would race a write it did not make.
 *
 * @module seed-stores
 */
import { type Storage, textValueStore } from '@lostgradient/storage';

import {
  createHookStore,
  HOOK_DELIVERY_KEY_PREFIX,
  HOOK_DELIVERY_PENDING_KEY_PREFIX,
  type HookStore,
} from '../hooks/hook-store.ts';

export type { HookStore } from '../hooks/hook-store.ts';
export type { HookDeliveryAttempt, HookDeliveryRecord, HookRecord } from '../hooks/hook-types.ts';

/** The Bureau stores a fixture may write through, over one storage. */
export interface BureauSeedStores {
  /**
   * Hooks and their deliveries, written with the keys and pending index a Bureau writes.
   * `createDelivery` throws for a record a Bureau would skip as unreadable, rather than writing it.
   */
  readonly hooks: HookStore;
}

/**
 * Opens the Bureau's stores over `storage`, which must hold no running Bureau. The storage stays
 * the caller's: nothing here disposes it.
 */
export function openBureauSeedStores(storage: Storage): BureauSeedStores {
  const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
  const hooks = createHookStore(kv);
  return {
    hooks: {
      ...hooks,
      createDelivery: async (record) => {
        const created = await hooks.createDelivery(record);
        if (created && (await hooks.getDelivery(record.id)) === undefined) {
          await kv.delete(`${HOOK_DELIVERY_KEY_PREFIX}${record.id}`);
          await kv.delete(`${HOOK_DELIVERY_PENDING_KEY_PREFIX}${record.id}`);
          throw new Error(
            `The delivery ${record.id} would not read back: a Bureau skips a record it cannot parse ` +
              '(a webhook delivery needs its request).',
          );
        }
        return created;
      },
    },
  };
}
