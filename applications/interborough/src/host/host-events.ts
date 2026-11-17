/**
 * What the host tells Bureau about the plugin and secret changes it commits (COR-2098): the port
 * Bureau subscribes to (`BureauOptions.hostEvents`) and the `publish` the plugin manager calls once
 * a write is committed and audited.
 *
 * Bureau sees a secret only through `BureauPluginSecrets.watch`, which says a key changed and not
 * how, so the manager that writes it reports it. An event is published to the listeners there are
 * when it is published: none is held for a Bureau that is not listening yet, because the host
 * starts reporting only once it is serving writes. A listener that throws is isolated, as the
 * secret watchers are, so Bureau's failure is never the writer's.
 *
 * Nothing here carries a value: the payloads are the ones `BureauHostEvent` defines, which name a
 * plugin and the key it declares and no secret, configuration value or message.
 *
 * @module host-events
 */

import type { BureauHostEvent, BureauHostEvents } from '@lostgradient/bureau';

/** A kind and its payload, as the arguments of one `publish`: a union of pairs, one for each kind. */
export type HostEventArguments = {
  readonly [Event in BureauHostEvent as Event['kind']]: readonly [
    kind: Event['kind'],
    payload: Event['payload'],
  ];
}[BureauHostEvent['kind']];

/** What the plugin manager reports through. */
export type HostEventPublisher = {
  /** Reports one committed change to every listener. Never throws. */
  publish(...event: HostEventArguments): void;
};

/** The publisher the host keeps, and the port Bureau is given to hear it. */
export type HostEvents = HostEventPublisher & {
  /** The port for `BureauOptions.hostEvents`. */
  readonly port: BureauHostEvents;
};

/** The event a kind and its payload make. */
function eventOf(...[kind, payload]: HostEventArguments): BureauHostEvent {
  switch (kind) {
    case 'secret.set':
    case 'secret.removed':
      return { kind, payload: { plugin: payload.plugin, key: payload.key } };
    case 'plugin.settings-changed':
      return {
        kind,
        payload: {
          plugin: payload.plugin,
          enabled: payload.enabled,
          restartRequired: payload.restartRequired,
        },
      };
    case 'plugin.status-changed':
      return {
        kind,
        payload: {
          plugin: payload.plugin,
          previousStatus: payload.previousStatus,
          status: payload.status,
          problemCodes: [...payload.problemCodes],
        },
      };
  }
}

/** Creates the host's events: a `publish` for the manager and a `port` for Bureau. */
export function createHostEvents(): HostEvents {
  const listeners = new Set<(event: BureauHostEvent) => void>();
  return {
    port: {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    publish(...event) {
      for (const listener of Array.from(listeners)) {
        try {
          // Its own copy, built from the fields the shape names, so a listener that changes what it
          // was handed changes nothing the next one reads, and a field the shape does not name
          // never leaves the host.
          listener(eventOf(...event));
        } catch {
          // The listener is Bureau's; its failure is not the writer's.
        }
      }
    },
  };
}
