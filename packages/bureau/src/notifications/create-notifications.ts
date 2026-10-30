/**
 * Composes the notification store with the built-in notifications (COR-1941), so `createBureau`
 * wires one object: the in-process surface (`bureau.notifications`), the retention sweep, and the
 * start and stop of the listener that writes the built-in kinds.
 *
 * @module create-notifications
 */

import type { ConditionalTextValueStore } from '@lostgradient/storage';
import type { RuntimeClock, RuntimeIdentifiers } from '@lostgradient/lifecycle';

import { serializeUnknownError } from '../serialization.ts';
import type { DiagnosticSink } from '../types.ts';
import {
  type BuiltInNotificationsOptions,
  startBuiltInNotifications,
} from './built-in-notifications.ts';
import { createNotificationOutbox } from './notification-outbox.ts';
import { createNotificationStore } from './notification-store.ts';
import type { BureauNotification, BureauNotifications } from './notification-types.ts';

/** Options for {@link createNotifications}. */
export interface CreateNotificationsOptions {
  /** The Bureau's key-value store. Absent, the notifications are kept in memory. */
  readonly kv?: ConditionalTextValueStore | undefined;
  readonly clock: Pick<RuntimeClock, 'now' | 'nowISO'>;
  readonly identifiers: RuntimeIdentifiers;
  readonly diagnose: DiagnosticSink;
  /** Builds the error `create` rejects with for an input that does not meet its bounds. */
  readonly refusal: (message: string) => Error;
  /** The bureau emitter the built-in notifications listen to. */
  readonly source: BuiltInNotificationsOptions['source'];
  /** Reads a task's record by id. */
  readonly tasks: BuiltInNotificationsOptions['tasks'];
  /** Told of each notification this call wrote (not of one a dedupe key found); a throw is diagnosed. */
  readonly onCreated?: ((notification: BureauNotification) => void) | undefined;
}

/** The notifications of one Bureau. */
export interface Notifications {
  /** The in-process surface, `bureau.notifications`. */
  readonly notifications: BureauNotifications;
  /** Removes the notifications older than `olderThanMilliseconds`. Resolves how many. */
  prune(olderThanMilliseconds: number): Promise<number>;
  /**
   * Removes everything about the given runs (COR-1953): their notifications, for every owner, and
   * the outbox entries that would write a failure notification again. Waits for the writes already
   * started, so one in flight does not land after the removal. Resolves how many notifications went.
   */
  purgeRuns(runIds: ReadonlySet<string>): Promise<number>;
  /** Stops writing the built-in notifications. */
  stop(): void;
  /** Resolves when every write the built-in notifications started has settled. */
  drain(): Promise<void>;
  /**
   * Writes the notifications the outbox still owes (COR-1945): the failure of a run that settled
   * before a crash or a storage error kept its notification from being written.
   */
  repair(): Promise<void>;
}

/** Creates the notifications and starts listening for the events that write the built-in kinds. */
export function createNotifications(options: CreateNotificationsOptions): Notifications {
  const store = createNotificationStore(options);
  const create: BureauNotifications['create'] = async (input) => {
    const written = await store.create(input);
    if (written.created) {
      try {
        options.onCreated?.(written.notification);
      } catch (error: unknown) {
        options.diagnose({
          level: 'error',
          scope: 'notifications',
          message: `[bureau] A notification listener threw: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
    }
    return written;
  };
  const outbox = createNotificationOutbox(options.kv);
  const builtIn = startBuiltInNotifications({
    source: options.source,
    store: { create, dismissByDedupeKey: (dedupeKey) => store.dismissByDedupeKey(dedupeKey) },
    tasks: options.tasks,
    diagnose: options.diagnose,
    outbox,
  });
  return {
    notifications: {
      create,
      list: (query) => store.list(query),
      markRead: (selection) => store.markRead(selection),
      dismiss: (selection) => store.dismiss(selection),
    },
    prune: (olderThanMilliseconds) => store.prune(options.clock.now() - olderThanMilliseconds),
    async purgeRuns(runIds) {
      await builtIn.drain();
      for (const runId of runIds) await outbox.clear(runId);
      return store.purgeRuns(runIds);
    },
    stop: () => builtIn.stop(),
    drain: () => builtIn.drain(),
    repair: () => builtIn.repair(),
  };
}
