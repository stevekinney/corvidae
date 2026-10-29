/**
 * The shell's two live feeds over stubbed streams, for the component tests of a view that follows
 * them (COR-1725): the real `BureauEventSource` and `FleetEventSource`, a hub the test writes
 * frames to, and the `fetch` that routes a feed's request to the hub and any other to what was
 * installed before. The clock is the test's: call `jest.useFakeTimers()` first, because the helpers
 * that wait use `until` and `settle` (`../fake-timers.test-support.ts`).
 */
import { expect, jest } from 'bun:test';

import { settle, until } from '../fake-timers.test-support.ts';
import { BureauEventSource } from './bureau-event-source.svelte.ts';
import {
  envelopeChunk,
  EventStreamHub,
  REPLAY_COMPLETE_CHUNK,
} from './event-stream-hub.test-support.ts';
import { installFetchImplementation } from './fetch.test-support.ts';
import { FleetEventSource } from './fleet-event-source.svelte.ts';

/** A reconnect delay no test reaches, so a lost feed stays lost until the test says otherwise. */
function reconnectNever(): number {
  return 1_000_000;
}

export interface LiveFeeds {
  readonly hub: EventStreamHub;
  readonly bureauEvents: BureauEventSource;
  readonly fleetEvents: FleetEventSource;
  /** Waits for the Bureau's feed to open, ends its replay, and waits for it to be live. */
  bureauGoesLive(): Promise<void>;
  /** The same for the engine's fleet feed. */
  fleetGoesLive(): Promise<void>;
  /** Publishes one Bureau event and lets what it starts finish. */
  bureauEvent(kind: string, payload?: Record<string, unknown>): Promise<void>;
  /** Publishes one fleet frame and lets what it starts finish. */
  fleetEvent(kind: string, extra?: Record<string, unknown>): Promise<void>;
  /** Moves the clock `count` polls of `milliseconds` on, letting the reads each starts finish. */
  passPolls(count: number, milliseconds: number): Promise<void>;
  close(): void;
}

/** Opens both feeds over a hub. Install the Bureau stand-in first: this routes what it does not own to it. */
export function createLiveFeeds(): LiveFeeds {
  const hub = new EventStreamHub();
  const before = globalThis.fetch;
  const restoreFetch = installFetchImplementation(
    async (input, init) => hub.handle(input, init) ?? before(input, init),
  );
  const bureauEvents = new BureauEventSource({ computeReconnectDelayMs: reconnectNever });
  const fleetEvents = new FleetEventSource({
    baseUrl: '',
    computeReconnectDelayMs: reconnectNever,
  });
  let cursor = 0;
  const nextCursor = (): string => `live:${String((cursor += 1))}`;
  return {
    hub,
    bureauEvents,
    fleetEvents,
    async bureauGoesLive() {
      await until(() => expect(hub.opened('bureau')).toBeGreaterThan(0));
      hub.write('bureau', REPLAY_COMPLETE_CHUNK);
      await until(() => expect(bureauEvents.status).toBe('live'));
      await settle();
    },
    async fleetGoesLive() {
      await until(() => expect(hub.opened('fleet')).toBeGreaterThan(0));
      hub.write('fleet', REPLAY_COMPLETE_CHUNK);
      await until(() => expect(fleetEvents.caughtUp).toBe(true));
      await settle();
    },
    async bureauEvent(kind, payload = {}) {
      hub.write('bureau', envelopeChunk({ kind, cursor: nextCursor(), payload }));
      await settle();
    },
    async fleetEvent(kind, extra = {}) {
      hub.write('fleet', envelopeChunk({ kind, cursor: nextCursor(), ...extra }));
      await settle();
    },
    async passPolls(count, milliseconds) {
      for (let poll = 0; poll < count; poll += 1) {
        jest.advanceTimersByTime(milliseconds);
        await settle();
      }
    },
    close() {
      bureauEvents.close();
      fleetEvents.close();
      hub.endAll();
      restoreFetch();
    },
  };
}
