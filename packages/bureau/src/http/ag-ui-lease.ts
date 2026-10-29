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
 * through {@link AgUiLease.renew}, which says whether it still holds the lease).
 *
 * Assumptions, stated because a lease is only as good as they are:
 *
 * - Each process reads expiry from its own clock, so the clock skew between
 *   processes must stay below the lease length minus the renewal interval (two
 *   thirds of the lease); more skew lets a live claimant's lease read as expired.
 * - A record that cannot be read fails closed: it is not overwritten, so its thread
 *   or command stays held until an operator clears it.
 * - A step that outlives its lease can be overtaken. Inside one process Armorer's
 *   single-use approval binding stops a tool running twice, but that binding is held
 *   in the process's memory, so across processes only the ledger's compare-and-swap
 *   on the exact entry and the idempotent run-creation request id hold (one entry,
 *   one run) and the tool itself can run twice. It is a documented residual.
 * - Nothing sweeps expired records. They are tiny and bounded by the number of
 *   threads and commands, and the next acquisition of the same subject replaces one.
 *
 * @module ag-ui-lease
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import { type ConditionalTextValueStore, encodeStorageKeyComponent } from '@lostgradient/storage';

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
        let released = false;
        // Renewal and release read the record and then compare-and-swap against what
        // they read, so one running while the other reads would lose its swap (a
        // release that deletes the record a renewal has just replaced leaves the lease
        // standing). They run one after another, in the order they were asked.
        let queue: Promise<unknown> = Promise.resolve();
        const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
          const run = queue.then(operation, operation);
          queue = run.catch(() => undefined);
          return run;
        };
        const renewOnce = async (): Promise<boolean> => {
          if (lost || released) return false;
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
            void serialized(renewOnce).catch(() => {
              lost = true;
            });
          },
          Math.max(1, Math.floor(leaseMs / 3)),
        );
        return {
          renew: () => serialized(renewOnce),
          release() {
            released = true;
            runtime.timers.clearInterval(interval);
            // After any renewal already under way, so the record it leaves is the one deleted.
            return serialized(async () => {
              const current = await kv.get(key);
              if (current === null || parse(current)?.claimant !== claimant) return;
              await kv.conditionalBatch(
                [{ key, expectedValue: current }],
                [{ type: 'delete', key }],
              );
            });
          },
        };
      }
      return undefined;
    },
  };
}

/**
 * Gives a lease up without letting a store error fail the request it served: the
 * work is already done, and a lease nobody renews expires on its own.
 */
export async function releaseQuietly(lease: AgUiLease): Promise<void> {
  try {
    await lease.release();
  } catch (error) {
    // The mount has no diagnostics sink of its own; the Bureau's default is the console.
    // eslint-disable-next-line no-console
    console.error('[bureau] Could not release an AG-UI lease; it will expire:', error);
  }
}
