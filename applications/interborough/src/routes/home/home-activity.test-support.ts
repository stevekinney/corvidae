/**
 * Test-only support for Home's activity bands (COR-2227): the shell's two feed sources over a hub
 * the test writes frames to, and a Bureau that answers `bureau.deployment.get` and
 * `bureau.events.format` as the test says, recording each format call.
 */
import { BureauEventSource } from '../../lib/live-source/bureau-event-source.svelte.ts';
import {
  envelopeChunk,
  EventStreamHub,
  REPLAY_COMPLETE_CHUNK,
} from '../../lib/live-source/event-stream-hub.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { FleetEventSource } from '../../lib/live-source/fleet-event-source.svelte.ts';

/** The sample world's "now": Monday, Nov 2, 10:46 AM Central time. */
export const ACTIVITY_NOW = Date.parse('2026-11-02T10:46:00-06:00');

/** 10:42 AM, the day before at 4:12 PM, and Thursday, Oct 29 at 4:12 PM, in Central time. */
export const TODAY = Date.parse('2026-11-02T10:42:00-06:00');
export const YESTERDAY = Date.parse('2026-11-01T16:12:00-06:00');
export const OLDER = Date.parse('2026-10-29T16:12:00-05:00');

/** One event as `bureau.events.format` is sent it. */
export interface SentEvent {
  readonly kind: string;
  readonly payload: unknown;
}

/** One entry of a format answer, or `undefined` to answer the kind as unclaimed. */
export type Wording = Readonly<Record<string, unknown>> | undefined;

export interface ActivityWorld {
  readonly hub: EventStreamHub;
  readonly bureauEvents: BureauEventSource;
  readonly fleetEvents: FleetEventSource;
  /** Every `bureau.events.format` call, in order, with the events it was sent. */
  readonly formatCalls: SentEvent[][];
  /** How the Bureau words a kind; a kind not here is unclaimed. Set `failFormat` to fail every call. */
  readonly wordings: Map<string, Wording>;
  failFormat: boolean;
  restore(): void;
}

/** Writes one Bureau envelope to the feed's open stream. */
export function bureauEnvelope(
  cursor: string,
  kind: string,
  emittedAtMs: number,
  payload: Record<string, unknown> = {},
): string {
  return envelopeChunk({ kind, cursor, emittedAtMs, payload, sequence: 1 });
}

/** One fleet frame as the engine's feed writes it. */
export function fleetFrame(
  cursor: string,
  kind: string,
  emittedAtMs: number,
  payload: Record<string, unknown> = {},
): string {
  const workflowId = payload['workflowId'];
  return envelopeChunk({
    kind,
    cursor,
    emittedAtMs,
    payload,
    sequence: 1,
    ...(typeof workflowId === 'string' ? { workflowId } : {}),
  });
}

export { REPLAY_COMPLETE_CHUNK };

/** Installs the hub and the Bureau stand-in, and opens both sources, as the shell does. */
export function installActivityWorld(): ActivityWorld {
  const hub = new EventStreamHub();
  const formatCalls: SentEvent[][] = [];
  const wordings = new Map<string, Wording>();
  const world = {
    hub,
    formatCalls,
    wordings,
    failFormat: false,
  };
  const restoreFetch = installFetchImplementation(async (input, init) => {
    const own = hub.handle(input, init);
    if (own !== undefined) return own;
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      method?: string;
      params?: { events?: SentEvent[] };
    };
    if (body.method === 'bureau.deployment.get') {
      return Response.json({ jsonrpc: '2.0', id: 'x', result: { id: 'bureau-1' } });
    }
    if (body.method === 'bureau.events.format') {
      const events = body.params?.events ?? [];
      formatCalls.push(events);
      if (world.failFormat) {
        return Response.json({
          jsonrpc: '2.0',
          id: 'x',
          error: { code: -32603, message: 'The formatter host stopped.' },
        });
      }
      return Response.json({
        jsonrpc: '2.0',
        id: 'x',
        result: {
          events: events.map((event) => {
            const wording = wordings.get(event.kind);
            return wording === undefined
              ? { kind: event.kind, title: event.kind, tier: 'info' }
              : { kind: event.kind, formattedBy: 'showcase/words', tier: 'info', ...wording };
          }),
        },
      });
    }
    return new Response('Not found', { status: 404 });
  });
  const bureauEvents = new BureauEventSource({ computeReconnectDelayMs: () => 1_000_000 });
  const fleetEvents = new FleetEventSource({
    baseUrl: '',
    computeReconnectDelayMs: () => 1_000_000,
  });
  return Object.assign(world, {
    bureauEvents,
    fleetEvents,
    restore() {
      bureauEvents.close();
      fleetEvents.close();
      hub.endAll();
      restoreFetch();
    },
  });
}
