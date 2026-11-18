/**
 * `BureauEventSource.recent` (COR-2227): the window a view that lists recent events reads when it
 * opens and on every resync. It holds the replay the source held back as well as what arrived live,
 * once per cursor, up to one format batch, and a gap or a refusal empties it.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { waitUntil } from '@lostgradient/testing/wait-until';

import { BUREAU_RESYNC_KIND, type BureauEventFrame } from './bureau-event-frame.ts';
import { BUREAU_RECENT_CAP, BureauEventSource } from './bureau-event-source.svelte.ts';
import {
  envelopeChunk,
  EventStreamHub,
  REPLAY_COMPLETE_CHUNK,
} from './event-stream-hub.test-support.ts';
import { installFetchImplementation } from './fetch.test-support.ts';

let hub: EventStreamHub;
let restoreFetch: (() => void) | undefined;
let source: BureauEventSource | undefined;

function install(): void {
  hub = new EventStreamHub();
  restoreFetch = installFetchImplementation(async (input, init) => {
    const own = hub.handle(input, init);
    if (own !== undefined) return own;
    return Response.json({ jsonrpc: '2.0', id: 'x', result: { id: 'bureau-1' } });
  });
}

afterEach(() => {
  source?.close();
  source = undefined;
  hub.endAll();
  restoreFetch?.();
});

function connect(delay = 0): BureauEventFrame[] {
  const frames: BureauEventFrame[] = [];
  source = new BureauEventSource({ computeReconnectDelayMs: () => delay });
  source.subscribe((frame) => frames.push(frame));
  return frames;
}

const cursors = (frames: readonly BureauEventFrame[]) => frames.map((frame) => frame.cursor);

describe('BureauEventSource.recent', () => {
  test('is empty before anything arrives', () => {
    install();
    connect();
    expect(source?.recent()).toEqual([]);
  });

  test('holds the replay it held back, so a view reads it on the one resync instead of one by one', async () => {
    install();
    const frames = connect();
    await waitUntil(() => hub.opened('bureau') === 1);
    hub.write(
      'bureau',
      envelopeChunk({ kind: 'review.requested', cursor: 'a:1' }),
      envelopeChunk({ kind: 'run.settled', cursor: 'a:2' }),
      REPLAY_COMPLETE_CHUNK,
    );
    await waitUntil(() => frames.length === 1);
    // The subscriber is sent one resync, never the replayed envelopes themselves.
    expect(frames.map((frame) => frame.kind)).toEqual([BUREAU_RESYNC_KIND]);
    expect(cursors(source?.recent() ?? [])).toEqual(['a:1', 'a:2']);

    hub.write('bureau', envelopeChunk({ kind: 'goal.attempt.started', cursor: 'a:3' }));
    await waitUntil(() => frames.length === 2);
    expect(cursors(source?.recent() ?? [])).toEqual(['a:1', 'a:2', 'a:3']);
    expect(cursors(source?.recent(2) ?? [])).toEqual(['a:2', 'a:3']);
    expect(source?.recent(0)).toEqual([]);
  });

  test('keeps each cursor once when a reconnect replays what it already holds, and never a recovery signal', async () => {
    install();
    const frames = connect();
    await waitUntil(() => hub.opened('bureau') === 1);
    hub.write(
      'bureau',
      envelopeChunk({ kind: 'run.settled', cursor: 'a:1' }),
      REPLAY_COMPLETE_CHUNK,
    );
    await waitUntil(() => frames.length === 1);
    hub.end('bureau');
    await waitUntil(() => hub.opened('bureau') === 2);
    hub.write(
      'bureau',
      envelopeChunk({ kind: 'run.settled', cursor: 'a:1' }),
      envelopeChunk({ kind: 'frames.dropped', cursor: 'a:2' }),
      envelopeChunk({ kind: 'run.settled', cursor: 'a:3' }),
      REPLAY_COMPLETE_CHUNK,
    );
    await waitUntil(() => frames.some((frame) => frame.kind === 'frames.dropped'));
    await waitUntil(() => frames.filter((frame) => frame.kind === BUREAU_RESYNC_KIND).length === 2);
    expect(cursors(source?.recent() ?? [])).toEqual(['a:1', 'a:3']);
  });

  test('a gap empties the window, since the replay that follows is the feed’s new history', async () => {
    install();
    const frames = connect();
    await waitUntil(() => hub.opened('bureau') === 1);
    hub.write(
      'bureau',
      envelopeChunk({ kind: 'run.settled', cursor: 'a:1' }),
      REPLAY_COMPLETE_CHUNK,
    );
    await waitUntil(() => frames.length === 1);
    hub.write(
      'bureau',
      envelopeChunk({ kind: 'feed.gap', cursor: 'b:0' }),
      envelopeChunk({ kind: 'run.settled', cursor: 'b:1' }),
    );
    await waitUntil(() => frames.length === 3);
    expect(cursors(source?.recent() ?? [])).toEqual(['b:1']);
  });

  test('holds no more than one format batch, dropping the oldest', async () => {
    install();
    const frames = connect();
    await waitUntil(() => hub.opened('bureau') === 1);
    const chunks = Array.from({ length: BUREAU_RECENT_CAP + 5 }, (_, index) =>
      envelopeChunk({ kind: 'run.settled', cursor: `a:${String(index + 1)}` }),
    );
    hub.write('bureau', ...chunks, REPLAY_COMPLETE_CHUNK);
    await waitUntil(() => frames.length === 1);
    const recent = source?.recent() ?? [];
    expect(recent).toHaveLength(BUREAU_RECENT_CAP);
    expect(recent[0]?.cursor).toBe('a:6');
    expect(recent.at(-1)?.cursor).toBe(`a:${String(BUREAU_RECENT_CAP + 5)}`);
  });
});

describe('BureauEventSource.retryNow', () => {
  test('connects at once when a reconnect is waiting out its backoff, and counts the attempts', async () => {
    install();
    hub.refusals.bureau = 503;
    connect(1_000_000);
    await waitUntil(() => source?.reconnectAttempt === 1);
    expect(source?.status).toBe('reconnecting');
    expect(hub.requests.bureau).toHaveLength(1);
    source?.retryNow();
    await waitUntil(() => hub.opened('bureau') === 1);
    hub.write('bureau', REPLAY_COMPLETE_CHUNK);
    await waitUntil(() => source?.caughtUp === true);
    expect(source?.reconnectAttempt).toBe(0);
  });

  test('a stream whose first frame is an error never resets the backoff, so it keeps backing off', async () => {
    install();
    connect(1_000_000);
    await waitUntil(() => hub.opened('bureau') === 1);
    for (let drop = 1; drop <= 3; drop += 1) {
      hub.write('bureau', 'event: error\ndata: {"message":"boom"}\n\n');
      await waitUntil(() => source?.failedConnections === drop);
      expect(source?.reconnectAttempt).toBe(drop);
      source?.retryNow();
      await waitUntil(() => hub.requests.bureau.length === drop + 1);
    }
  });

  test('failedConnections counts every failure and drop, and an event that resets the attempt never lowers it', async () => {
    install();
    hub.refusals.bureau = 503;
    connect(1_000_000);
    await waitUntil(() => source?.failedConnections === 1);
    expect(source?.reconnectAttempt).toBe(1);
    source?.retryNow();
    await waitUntil(() => hub.opened('bureau') === 1);
    // The connection delivers an event, so the attempt starts again at 0.
    hub.write('bureau', envelopeChunk({ kind: 'run.settled', cursor: 'a:1' }));
    await waitUntil(() => source?.reconnectAttempt === 0);
    expect(source?.failedConnections).toBe(1);
    // Then it drops: the attempt is 1 again, as it was before, and the failures are 2.
    hub.end('bureau');
    await waitUntil(() => source?.failedConnections === 2);
    expect(source?.reconnectAttempt).toBe(1);
  });

  test('does nothing while connected', async () => {
    install();
    connect();
    await waitUntil(() => hub.opened('bureau') === 1);
    source?.retryNow();
    expect(hub.requests.bureau).toHaveLength(1);
  });
});
