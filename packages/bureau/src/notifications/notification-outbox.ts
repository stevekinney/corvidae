/**
 * The notification outbox (COR-1945): a durable promise that a failed run's notification will be
 * written.
 *
 * A run's settlement and its failure notification are two writes: the task registry commits the
 * settlement, then the `run.settled` event it dispatches lets the built-in notifications write the
 * notification. A process that dies between the two, or a storage error on the second, would lose
 * the notification for good: nothing replays an event. So the registry writes one entry here in the
 * same conditional batch as the settlement of a run that ended `failed`, and the built-in
 * notifications clear it only once the notification exists (written now, or found under the run's
 * dedupe key). An entry still present at the next boot is a notification owed; the boot walks the
 * outbox and writes each one. The write is idempotent by the run's dedupe key, so a repair that
 * runs twice, or beside the live write, produces one notification.
 *
 * An entry is the run id in the key, under `bureau-notification:v1:o:` (outside the `r:` and `d:`
 * prefixes the store scans), and carries no content: the notification is built from the task record
 * at repair time, as the live write builds it.
 *
 * @module notification-outbox
 */

import {
  type ConditionalTextValueStore,
  decodeStorageKeyComponent,
  encodeStorageKeyComponent,
} from '@lostgradient/storage';

import { NOTIFICATION_KEY_PREFIX } from './notification-store.ts';

const outboxPrefix = `${NOTIFICATION_KEY_PREFIX}o:`;

/** The key of the outbox entry for `runId`. */
export function notificationOutboxKey(runId: string): string {
  return `${outboxPrefix}${encodeStorageKeyComponent(runId)}`;
}

/** The notifications owed, by run. */
export interface NotificationOutbox {
  /** The ids of the runs whose notification is still owed. */
  pending(): Promise<string[]>;
  /** Removes the entry of `runId`; absent, nothing happens. */
  clear(runId: string): Promise<void>;
}

/** Reads and clears the outbox kept in `kv`. */
export function createNotificationOutbox(
  kv: ConditionalTextValueStore | undefined,
): NotificationOutbox {
  return {
    async pending() {
      if (kv === undefined) return [];
      const runIds: string[] = [];
      for (const key of await kv.list(outboxPrefix)) {
        runIds.push(decodeStorageKeyComponent(key.slice(outboxPrefix.length)));
      }
      return runIds;
    },
    async clear(runId) {
      await kv?.delete(notificationOutboxKey(runId));
    },
  };
}
