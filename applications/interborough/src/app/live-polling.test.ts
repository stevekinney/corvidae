/**
 * The review queries ask on a timer only while the feed that carries their data is not live, and
 * ask again once per event of that feed (COR-1722). The sources are the real ones over stubbed
 * streams; TanStack Query's refetch interval is the timer, so the clock is faked and moved by hand.
 */
import { QueryClient } from '@tanstack/svelte-query';
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import type { HttpClient } from '@lostgradient/weft';

import { settle, until } from '../lib/fake-timers.test-support.ts';
import { BureauEventSource } from '../lib/live-source/bureau-event-source.svelte.ts';
import {
  envelopeChunk,
  EventStreamHub,
  REPLAY_COMPLETE_CHUNK,
} from '../lib/live-source/event-stream-hub.test-support.ts';
import { installFetchImplementation } from '../lib/live-source/fetch.test-support.ts';
import { FleetEventSource } from '../lib/live-source/fleet-event-source.svelte.ts';
import { REVIEW_POLL_MILLISECONDS } from '../routes/reviews/reviews-data.ts';
import LivePollingHarness from './live-polling.test-harness.svelte';

let hub: EventStreamHub;
let restoreFetch: () => void;
let bureauReads: number;
let engineReads: number;
let bureauEvents: BureauEventSource;
let fleetEvents: FleetEventSource;

const client = {
  listReviews: async () => {
    engineReads += 1;
    return [];
  },
} as unknown as HttpClient;

beforeEach(() => {
  jest.useFakeTimers();
  hub = new EventStreamHub();
  bureauReads = 0;
  engineReads = 0;
  restoreFetch = installFetchImplementation(async (input, init) => {
    const own = hub.handle(input, init);
    if (own !== undefined) return own;
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    const method = typeof body === 'object' && body !== null ? Reflect.get(body, 'method') : '';
    if (method === 'bureau.deployment.get') {
      return Response.json({ jsonrpc: '2.0', id: method, result: { id: 'bureau-1' } });
    }
    if (method === 'bureau.reviews.list') {
      bureauReads += 1;
      return Response.json({ jsonrpc: '2.0', id: method, result: { reviews: [] } });
    }
    return new Response('Not found', { status: 404 });
  });
  bureauEvents = new BureauEventSource({ computeReconnectDelayMs: () => 1_000_000 });
  fleetEvents = new FleetEventSource({ baseUrl: '', computeReconnectDelayMs: () => 1_000_000 });
});

afterEach(() => {
  cleanup();
  bureauEvents.close();
  fleetEvents.close();
  hub.endAll();
  jest.useRealTimers();
  restoreFetch();
});

async function mountPage(): Promise<void> {
  render(LivePollingHarness, {
    props: {
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      client,
      bureauEvents,
      fleetEvents,
    },
  } as never);
  await until(() => {
    expect(bureauReads).toBe(1);
    expect(engineReads).toBe(1);
    expect(hub.opened('bureau')).toBe(1);
    expect(hub.opened('fleet')).toBe(1);
  });
}

/** Moves the clock a few polls on and lets the reads it starts finish. */
async function passPolls(count = 6): Promise<void> {
  for (let poll = 0; poll < count; poll += 1) {
    jest.advanceTimersByTime(REVIEW_POLL_MILLISECONDS);
    await settle();
  }
}

describe('the Bureau’s pending reviews', () => {
  test('are asked on a timer while the Bureau’s feed is not live', async () => {
    await mountPage();
    await passPolls(3);
    expect(bureauReads).toBeGreaterThanOrEqual(3);
  });

  test('are not asked on a timer while it is live, and are asked once per review event', async () => {
    await mountPage();
    hub.write('bureau', REPLAY_COMPLETE_CHUNK);
    await until(() => expect(bureauEvents.status).toBe('live'));
    await settle();
    const before = bureauReads;

    await passPolls();
    expect(bureauReads).toBe(before);

    hub.write('bureau', envelopeChunk({ kind: 'review.requested', cursor: 'a:1' }));
    await until(() => expect(bureauReads).toBe(before + 1));
    await passPolls(2);
    expect(bureauReads).toBe(before + 1);

    hub.write('bureau', envelopeChunk({ kind: 'review.approved', cursor: 'a:2' }));
    await until(() => expect(bureauReads).toBe(before + 2));
  });

  test('are not asked for an event they do not carry', async () => {
    await mountPage();
    hub.write('bureau', REPLAY_COMPLETE_CHUNK);
    await until(() => expect(bureauEvents.status).toBe('live'));
    await settle();
    const before = bureauReads;
    hub.write('bureau', envelopeChunk({ kind: 'run.settled', cursor: 'a:1' }));
    await passPolls(2);
    expect(bureauReads).toBe(before);
  });

  test('are asked again when the feed reports a gap, then it carries on live', async () => {
    await mountPage();
    hub.write('bureau', REPLAY_COMPLETE_CHUNK);
    await until(() => expect(bureauEvents.status).toBe('live'));
    await settle();
    const before = bureauReads;
    hub.write(
      'bureau',
      envelopeChunk({
        kind: 'feed.gap',
        cursor: 'b:0',
        payload: { requestedCursor: 'a:9', firstRetainedSequence: 0 },
      }),
    );
    await until(() => expect(bureauReads).toBe(before + 1));
    expect(bureauEvents.status).toBe('live');
    await passPolls(2);
    expect(bureauReads).toBe(before + 1);
  });

  test('go back to the timer when the feed is lost', async () => {
    await mountPage();
    hub.write('bureau', REPLAY_COMPLETE_CHUNK);
    await until(() => expect(bureauEvents.status).toBe('live'));
    hub.end('bureau');
    await until(() => expect(bureauEvents.status).toBe('reconnecting'));
    await settle();
    const before = bureauReads;
    await passPolls(3);
    expect(bureauReads).toBeGreaterThan(before);
  });
});

describe('the engine’s pending reviews', () => {
  test('are asked on a timer while the fleet feed is not live', async () => {
    await mountPage();
    await passPolls(3);
    expect(engineReads).toBeGreaterThanOrEqual(3);
  });

  test('are not asked on a timer while it is live, and are asked once per review frame', async () => {
    await mountPage();
    hub.write('fleet', REPLAY_COMPLETE_CHUNK);
    await until(() => expect(fleetEvents.caughtUp).toBe(true));
    await settle();
    const before = engineReads;

    await passPolls();
    expect(engineReads).toBe(before);

    hub.write(
      'fleet',
      envelopeChunk({ kind: 'human-review:requested', cursor: '1', workflowId: 'wf_1' }),
    );
    await until(() => expect(engineReads).toBe(before + 1));
    await passPolls(2);
    expect(engineReads).toBe(before + 1);

    hub.write('fleet', envelopeChunk({ kind: 'human-review:completed', cursor: '2' }));
    await until(() => expect(engineReads).toBe(before + 2));
  });

  test('are not asked for a frame that is not a review’s', async () => {
    await mountPage();
    hub.write('fleet', REPLAY_COMPLETE_CHUNK);
    await until(() => expect(fleetEvents.caughtUp).toBe(true));
    await settle();
    const before = engineReads;
    hub.write('fleet', envelopeChunk({ kind: 'alert:fired', cursor: '1' }));
    await passPolls(2);
    expect(engineReads).toBe(before);
  });

  test('a replay is answered by one read, not one per frame', async () => {
    await mountPage();
    const before = engineReads;
    hub.write(
      'fleet',
      envelopeChunk({ kind: 'human-review:requested', cursor: '1' }),
      envelopeChunk({ kind: 'human-review:completed', cursor: '2' }),
      envelopeChunk({ kind: 'human-review:requested', cursor: '3' }),
      REPLAY_COMPLETE_CHUNK,
    );
    await until(() => expect(engineReads).toBe(before + 1));
    await passPolls(2);
    expect(engineReads).toBe(before + 1);
  });

  test('are asked again when the fleet feed reports a gap', async () => {
    await mountPage();
    hub.write('fleet', REPLAY_COMPLETE_CHUNK);
    await until(() => expect(fleetEvents.caughtUp).toBe(true));
    await settle();
    const before = engineReads;
    hub.write(
      'fleet',
      envelopeChunk({
        kind: 'fleet:gap',
        cursor: '9',
        payload: { requestedCursor: '1', firstRetainedSequence: 5 },
      }),
    );
    await until(() => expect(engineReads).toBe(before + 1));
  });
});
