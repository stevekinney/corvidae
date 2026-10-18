/**
 * Durable leases for the AG-UI mount.
 *
 * Bureau's default durable ownership posture (`'workflow-lease'`) lets several
 * processes share one backend, so a guarantee the mount makes (one run admitted to
 * a thread at a time, one process applying a resume at a time) cannot rest on state
 * in one process. A lease is a record in the Bureau's `ConditionalTextValueStore`,
 * written by compare-and-swap, that names its claimant and says until when it
 * holds. While it holds, no other claimant gets it; once it has expired, one
 * claimant may take it over, and a claimant that died is therefore only waited for,
 * never obeyed forever.
 *
 * Persisted shape (new, versioned; the prefix is disjoint from the command
 * ledgers' `command-ledger:v1` and `command-ledger:ag-ui-resume:v1`):
 *
 * - key: `ag-ui-lease:v1:<kind>:<encodeStorageKeyComponent(subject)>`, where `kind`
 *   is `thread` (a thread's admission) or `resume` (one resume command);
 * - value: JSON `{ "claimant": string, "expiresAt": number }`, `expiresAt` in epoch
 *   milliseconds on the injected runtime clock.
 *
 * `claimant` is minted per acquisition, so a claimant that was taken over cannot
 * renew or release the lease its successor holds: both are compare-and-swap on the
 * exact record the claimant wrote. A claimant renews while it works (on an
 * interval of the injected timers, and by hand before each step it cannot take back,
 * through {@link AgUiLease.renew}, which says whether it still holds the lease), but
 * a step that outlives the lease can still be overtaken, which is why Armorer's
 * single-use approval binding is a second line of defence for a tool that runs.
 *
 * @module ag-ui-lease
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import { type ConditionalTextValueStore, encodeStorageKeyComponent } from '@lostgradient/weft';

export const AG_UI_LEASE_KEY_PREFIX = 'ag-ui-lease:v1';

/** How long a lease holds without a renewal, in milliseconds. */
export const DEFAULT_AG_UI_LEASE_MS = 30_000;

/** Bounds the compare-and-swap loop against claimants racing for one lease. */
const MAXIMUM_ATTEMPTS = 8;

type LeaseKind = 'thread' | 'resume';

type LeaseRecord = { readonly claimant: string; readonly expiresAt: number };

export type AgUiLease = {
  /** Extends the lease. Resolves `false` when it is no longer this claimant's, in which case nothing may be done under it. */
  renew(): Promise<boolean>;
  /** Gives the lease up, if it is still this claimant's. */
  release(): Promise<void>;
};

export type AgUiLeases = {
  /** The lease on `subject`, or `undefined` while another claimant holds it. */
  acquire(kind: LeaseKind, subject: string): Promise<AgUiLease | undefined>;
};

function parse(raw: string): LeaseRecord | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as LeaseRecord).claimant === 'string' &&
      typeof (value as LeaseRecord).expiresAt === 'number' &&
      Number.isFinite((value as LeaseRecord).expiresAt)
    ) {
      return value as LeaseRecord;
    }
  } catch {
    // Unreadable: treated as held below.
  }
  return undefined;
}

export function createAgUiLeases(options: {
  readonly kv: ConditionalTextValueStore;
  readonly runtime: Pick<RuntimeServices, 'clock' | 'timers' | 'identifiers'>;
  readonly leaseMs?: number | undefined;
}): AgUiLeases {
  const { kv, runtime } = options;
  const leaseMs = options.leaseMs ?? DEFAULT_AG_UI_LEASE_MS;
  const record = (claimant: string): string =>
    JSON.stringify({ claimant, expiresAt: runtime.clock.now() + leaseMs } satisfies LeaseRecord);

  return {
    async acquire(kind, subject) {
      const key = `${AG_UI_LEASE_KEY_PREFIX}:${kind}:${encodeStorageKeyComponent(subject)}`;
      const claimant = runtime.identifiers.next('ag-ui-lease');
      for (let attempt = 0; attempt < MAXIMUM_ATTEMPTS; attempt += 1) {
        const stored = await kv.get(key);
        if (stored !== null) {
          const held = parse(stored);
          // An unreadable record fails closed: it is not for this claimant to overwrite.
          if (held === undefined || runtime.clock.now() < held.expiresAt) return undefined;
        }
        const taken = await kv.conditionalBatch(
          [{ key, expectedValue: stored }],
          [{ type: 'set', key, value: record(claimant) }],
        );
        if (!taken) continue;

        let lost = false;
        const renew = async (): Promise<boolean> => {
          if (lost) return false;
          const current = await kv.get(key);
          const held = current === null ? undefined : parse(current);
          if (current === null || held?.claimant !== claimant) {
            lost = true;
            return false;
          }
          const renewed = await kv.conditionalBatch(
            [{ key, expectedValue: current }],
            [{ type: 'set', key, value: record(claimant) }],
          );
          if (!renewed) lost = true;
          return renewed;
        };
        // A step that takes longer than the lease keeps it by this interval; a
        // renewal that fails marks the lease lost, and the next explicit renew says so.
        const interval = runtime.timers.setInterval(
          () => {
            void renew().catch(() => {
              lost = true;
            });
          },
          Math.max(1, Math.floor(leaseMs / 3)),
        );
        return {
          renew,
          async release() {
            runtime.timers.clearInterval(interval);
            const current = await kv.get(key);
            if (current === null || parse(current)?.claimant !== claimant) return;
            await kv.conditionalBatch([{ key, expectedValue: current }], [{ type: 'delete', key }]);
          },
        };
      }
      return undefined;
    },
  };
}
