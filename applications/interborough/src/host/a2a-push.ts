/**
 * A2A push-notification delivery for the host (COR-1819), built only when the `a2a.push.enabled`
 * setting is on.
 *
 * Bureau's handler takes the sender and the outbox it enqueues to, and the host drives delivery
 * itself, because the handler owns no timer for it. Configurations and deliveries live in the
 * host's own database, so they survive a restart and every host on that database shares them. The
 * outbox's adapter uses Weft's default egress policy: HTTPS to public addresses only, so a
 * configuration naming a loopback or private address is refused rather than delivered.
 *
 * @module a2a-push
 */

import type { BureauHandlerOptions, SettingsSnapshot } from '@lostgradient/bureau';
import { type Storage } from '@lostgradient/storage';
import { Outbox } from '@lostgradient/weft';
import {
  createEgressPolicy,
  createHttpDeliveryAdapter,
  createOutboxPushNotificationSender,
  createWeftPushNotificationStore,
  pushNotificationResolvers,
  startPushDelivery,
} from '@lostgradient/weft/a2a';

/** The storage namespace the push configurations and the outbox share. */
const A2A_PUSH_NAMESPACE = 'interborough-a2a-push';

/** How often delivery drains the outbox. */
const DELIVERY_INTERVAL_MS = 1_000;

/** A running push delivery: what the handler is given, and how to stop it. */
export type HostPushDelivery = {
  /** The handler's `pushNotifications` option. */
  readonly pushNotifications: NonNullable<BureauHandlerOptions['pushNotifications']>;
  /** Stop the delivery loop, wait for its last drain, and release the outbox. */
  stop(): Promise<void>;
};

/**
 * Starts push delivery over `storage` when `values` turn it on; `undefined` when they do not, so a
 * host with the setting off builds no outbox and runs no loop. `ownerId` is the deployment's
 * identifier, so the hosts of one deployment share one outbox and claim its deliveries by lease.
 */
export function startHostPushDelivery(
  storage: Storage,
  ownerId: string,
  values: SettingsSnapshot['values'],
  warn: (message: string) => void,
): HostPushDelivery | undefined {
  if (values['a2a.push.enabled'] !== true) return undefined;
  const pushStore = createWeftPushNotificationStore({ storage, namespace: A2A_PUSH_NAMESPACE });
  const outbox = new Outbox({
    storage,
    namespace: A2A_PUSH_NAMESPACE,
    ownerId,
    adapter: createHttpDeliveryAdapter({
      ...pushNotificationResolvers(pushStore),
      egressPolicy: createEgressPolicy(),
    }),
  });
  const sender = createOutboxPushNotificationSender({ outbox, pushStore });
  const stopping = new AbortController();
  const delivering = startPushDelivery({
    outbox,
    intervalMs: DELIVERY_INTERVAL_MS,
    signal: stopping.signal,
    onError: (error) => warn(`A2A push delivery failed: ${String(error)}`),
  });
  // A loop that cannot start rejects at once; `stop` awaits the same promise, so the failure is
  // reported there too, and this keeps it from going unhandled in between.
  delivering.catch((error: unknown) => warn(`A2A push delivery stopped: ${String(error)}`));
  const sweepIntervalMs = values['a2a.push.sweepIntervalMs'];
  return {
    pushNotifications: {
      sender,
      outbox,
      ...(sweepIntervalMs === undefined ? {} : { sweepIntervalMs }),
    },
    async stop() {
      stopping.abort();
      try {
        await delivering;
      } finally {
        outbox.dispose();
      }
    },
  };
}
