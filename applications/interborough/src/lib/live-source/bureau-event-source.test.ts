import { afterEach, describe, expect, test } from 'bun:test';

import { waitUntil } from '@lostgradient/testing/wait-until';

import { BUREAU_RESYNC_KIND, type BureauEventFrame } from './bureau-event-frame.ts';
import { BureauEventSource } from './bureau-event-source.svelte.ts';
import {
  envelopeChunk,
  EventStreamHub,
  REPLAY_COMPLETE_CHUNK,
} from './event-stream-hub.test-support.ts';
import { installFetchImplementation } from './fetch.test-support.ts';

let hub: EventStreamHub;
let restoreFetch: (() => void) | undefined;
let deploymentReads: number;
let source: BureauEventSource | undefined;

function install(deploymentId = 'bureau-1'): void {
  hub = new EventStreamHub();
  deploymentReads = 0;
  restoreFetch = installFetchImplementation(async (input, init) => {
    const own = hub.handle(input, init);
    if (own !== undefined) return own;
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    if (
      typeof body === 'object' &&
      body !== null &&
      Reflect.get(body, 'method') === 'bureau.deployment.get'
    ) {
      deploymentReads += 1;
      return Response.json({ jsonrpc: '2.0', id: 'x', result: { id: deploymentId } });
    }
    return new Response('Not found', { status: 404 });
  });
}

afterEach(() => {
  source?.close();
  source = undefined;
  hub.endAll();
  restoreFetch?.();
});

function connect(): BureauEventFrame[] {
  const frames: BureauEventFrame[] = [];
  source = new BureauEventSource({ computeReconnectDelayMs: () => 0 });
  source.subscribe((frame) => frames.push(frame));
  return frames;
}

const kinds = (frames: readonly BureauEventFrame[]) => frames.map((frame) => frame.kind);

describe('BureauEventSource', () => {
  test('addresses the feed by the Bureau’s own id, with no cursor on a first connection', async () => {
    install('bureau-7');
    connect();
    await waitUntil(() => hub.opened('bureau') === 1);
    expect(hub.requests.bureau[0]?.url).toBe(
      '/bureau/v1/subscriptions/bureau.events?bureauId=bureau-7',
    );
    expect(hub.requests.bureau[0]?.lastEventId).toBeUndefined();
    expect(source?.status).toBe('connecting');
  });

  test('is live once the replay ends, and delivers what follows one envelope at a time', async () => {
    install();
    const frames = connect();
    await waitUntil(() => hub.opened('bureau') === 1);
    hub.write('bureau', REPLAY_COMPLETE_CHUNK);
    await waitUntil(() => source?.status === 'live');
    hub.write(
      'bureau',
      envelopeChunk({ kind: 'review.requested', cursor: 'a:1', payload: { reviewId: 'r1' } }),
      envelopeChunk({ kind: 'run.settled', cursor: 'a:2' }),
    );
    await waitUntil(() => frames.length === 2);
    expect(kinds(frames)).toEqual(['review.requested', 'run.settled']);
    expect(frames[0]?.payload).toEqual({ reviewId: 'r1' });
  });

  test('holds the replay back and says once, when it ends, that the page missed some', async () => {
    install();
    const frames = connect();
    await waitUntil(() => hub.opened('bureau') === 1);
    hub.write(
      'bureau',
      envelopeChunk({ kind: 'run.registered', cursor: 'a:1' }),
      envelopeChunk({ kind: 'action', cursor: 'a:2' }),
      envelopeChunk({ kind: 'review.requested', cursor: 'a:3' }),
    );
    await waitUntil(() => source?.status === 'live');
    expect(frames).toEqual([]);
    hub.write('bureau', REPLAY_COMPLETE_CHUNK);
    await waitUntil(() => frames.length === 1);
    expect(kinds(frames)).toEqual([BUREAU_RESYNC_KIND]);
  });

  test('says nothing when the replay was empty', async () => {
    install();
    const frames = connect();
    await waitUntil(() => hub.opened('bureau') === 1);
    hub.write('bureau', REPLAY_COMPLETE_CHUNK);
    await waitUntil(() => source?.caughtUp === true);
    expect(frames).toEqual([]);
  });

  test('delivers a gap and a dropped-frames marker as they arrive, even in a replay', async () => {
    install();
    const frames = connect();
    await waitUntil(() => hub.opened('bureau') === 1);
    hub.write(
      'bureau',
      envelopeChunk({
        kind: 'feed.gap',
        cursor: 'b:0',
        payload: { requestedCursor: 'a:9', firstRetainedSequence: 0 },
      }),
    );
    await waitUntil(() => frames.length === 1);
    expect(kinds(frames)).toEqual(['feed.gap']);
    hub.write('bureau', REPLAY_COMPLETE_CHUNK);
    await waitUntil(() => source?.caughtUp === true);
    hub.write('bureau', envelopeChunk({ kind: 'frames.dropped', cursor: 'b:3' }));
    await waitUntil(() => frames.length === 2);
    expect(kinds(frames)).toEqual(['feed.gap', 'frames.dropped']);
  });

  test('resumes a dropped connection from the last cursor it read, and continues live', async () => {
    install();
    const frames = connect();
    await waitUntil(() => hub.opened('bureau') === 1);
    hub.write(
      'bureau',
      REPLAY_COMPLETE_CHUNK,
      envelopeChunk({ kind: 'run.settled', cursor: 'a:4' }),
    );
    await waitUntil(() => frames.length === 1);

    hub.end('bureau');
    await waitUntil(() => hub.opened('bureau') === 2);
    expect(hub.requests.bureau[1]?.lastEventId).toBe('a:4');
    // The Bureau's id is read once, not at each reconnect.
    expect(deploymentReads).toBe(1);

    hub.write(
      'bureau',
      envelopeChunk({ kind: 'review.approved', cursor: 'a:5' }),
      REPLAY_COMPLETE_CHUNK,
    );
    await waitUntil(() => source?.caughtUp === true);
    // The envelope after the cursor was a replay, so it is answered by one resync.
    await waitUntil(() => frames.length === 2);
    expect(kinds(frames)).toEqual(['run.settled', BUREAU_RESYNC_KIND]);
    hub.write('bureau', envelopeChunk({ kind: 'review.denied', cursor: 'a:6' }));
    await waitUntil(() => frames.length === 3);
    expect(frames[2]?.kind).toBe('review.denied');
  });

  test('drops a cursor the Bureau refuses, asks again from nothing, and resyncs when caught up', async () => {
    install();
    const frames = connect();
    await waitUntil(() => hub.opened('bureau') === 1);
    hub.write(
      'bureau',
      REPLAY_COMPLETE_CHUNK,
      envelopeChunk({ kind: 'run.settled', cursor: 'a:4' }),
    );
    await waitUntil(() => frames.length === 1);

    hub.refusals.bureau = 400;
    hub.end('bureau');
    await waitUntil(() => hub.requests.bureau.length === 3);
    expect(hub.requests.bureau[1]?.lastEventId).toBe('a:4');
    expect(hub.requests.bureau[2]?.lastEventId).toBeUndefined();
    // The refusal made the Bureau's id suspect, so it is read again.
    expect(deploymentReads).toBe(2);

    hub.write('bureau', REPLAY_COMPLETE_CHUNK);
    await waitUntil(() => frames.length === 2);
    expect(frames[1]?.kind).toBe(BUREAU_RESYNC_KIND);
  });

  test('is not live while the Bureau cannot be reached, and keeps trying', async () => {
    install();
    hub.refusals.bureau = 503;
    connect();
    await waitUntil(() => hub.requests.bureau.length === 2);
    expect(source?.status).not.toBe('live');
  });

  test('closes its connection when the last subscriber leaves', async () => {
    install();
    source = new BureauEventSource({ computeReconnectDelayMs: () => 0 });
    const unsubscribe = source.subscribe(() => undefined);
    await waitUntil(() => hub.opened('bureau') === 1);
    unsubscribe();
    expect(source.status).toBe('closed');
  });
});
