/**
 * COR-1477 — a live subscriber whose buffer overflows receives exactly one
 * frames-dropped marker, and its stream continues.
 */
import { type AgentRunEventFeed, RunStartedEvent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { type BureauEventEnvelope, createBureauEventFeed } from './bureau-event-feed.ts';
import { RunRegisteredEvent } from './events.ts';
import { FRAMES_DROPPED_KIND } from './frames-dropped.ts';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import {
  attachRunEventFeed,
  type MutableAgentRunEventRegistry,
} from './run-event-feed-attachment.ts';

/** The value a pull produced; fails the test if the stream ended instead. */
async function valueOf<T>(pull: Promise<IteratorResult<T>>): Promise<T> {
  const result = await pull;
  if (result.done === true) throw new Error('expected the stream to yield a value');
  return result.value;
}

/** Whether a pull reports the stream ended. */
async function isDone<T>(pull: Promise<IteratorResult<T>>): Promise<boolean> {
  const result = await pull;
  return result.done === true;
}

/** Pulls from `iterator` until `done` says to stop, returning what it yielded. */
async function pullUntil<T>(
  iterator: AsyncIterator<T>,
  done: (collected: readonly T[]) => boolean,
): Promise<T[]> {
  const collected: T[] = [];
  while (!done(collected)) {
    const next = await iterator.next();
    if (next.done === true) break;
    collected.push(next.value);
  }
  return collected;
}

/**
 * Subscribes, consumes the replay (`replayed` events), and returns the iterator
 * with a pull already parked in the live phase, so the next publish reaches a
 * live buffer rather than the replay.
 */
async function parkInLivePhase<T>(
  subscribe: (options: { onReplayComplete: () => void }) => AsyncIterable<T>,
  replayed: number,
): Promise<{ iterator: AsyncIterator<T>; parked: Promise<IteratorResult<T>>; replay: T[] }> {
  let replayComplete!: () => void;
  const reachedLive = new Promise<void>((resolve) => {
    replayComplete = resolve;
  });
  const iterator = subscribe({ onReplayComplete: replayComplete })[Symbol.asyncIterator]();
  const replay = await pullUntil(iterator, (events) => events.length >= replayed);
  const parked = iterator.next();
  await reachedLive;
  return { iterator, parked, replay };
}

describe('the frames-dropped marker on the bureau event feed', () => {
  it('delivers exactly one marker when a subscriber overflows its buffer, then continues', async () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1', liveBufferSize: 2, now: () => 7 });
    feed.publish(new RunRegisteredEvent('run-0'));
    const { iterator, parked, replay } = await parkInLivePhase(
      (options) => feed.feed.subscribe(options),
      1,
    );
    expect(replay[0]).toMatchObject({ kind: 'run.registered', sequence: 0 });

    // Five arrive in one turn while the reader is parked: two fit the buffer,
    // the rest overflow it, which ends the underlying stream.
    for (let index = 1; index <= 5; index += 1)
      feed.publish(new RunRegisteredEvent(`run-${index}`));

    const received = [
      await valueOf(parked),
      ...(await pullUntil(iterator, (events) => events.length >= 5)),
    ];
    const kinds = received.map((event) => event.kind);
    expect(kinds.filter((kind) => kind === FRAMES_DROPPED_KIND)).toHaveLength(1);
    // The marker stands in front of the resumed stream and takes the position of
    // the last event the reader saw, so resuming from it skips nothing.
    expect(received[0]).toMatchObject({
      kind: FRAMES_DROPPED_KIND,
      sequence: 0,
      cursor: expect.stringMatching(/^[0-9a-f-]+:0$/),
      bureauId: 'bureau-1',
      emittedAtMs: 7,
    });
    // Every later event arrives once, in order.
    expect(received.slice(1).map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);

    // The stream continues: a new event is delivered live, with no second marker.
    feed.publish(new RunRegisteredEvent('run-6'));
    const live = await valueOf(iterator.next());
    expect(live).toMatchObject({ kind: 'run.registered', sequence: 6 });

    await iterator.return?.();
    feed.dispose();
  });

  it('resumes past a replay limit that the overflowed buffer exceeds, instead of failing the stream', async () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1', liveBufferSize: 2 });
    feed.publish(new RunRegisteredEvent('run-0'));
    const { iterator, parked } = await parkInLivePhase(
      // The limit the catalog operations pass: a cold resume may replay this many.
      (options) => feed.feed.subscribe({ ...options, replayLimit: 2 }),
      1,
    );

    for (let index = 1; index <= 5; index += 1)
      feed.publish(new RunRegisteredEvent(`run-${index}`));

    const received = [
      await valueOf(parked),
      ...(await pullUntil(iterator, (events) => events.length >= 5)),
    ];
    expect(received.map((event) => event.kind)).toEqual([
      FRAMES_DROPPED_KIND,
      'run.registered',
      'run.registered',
      'run.registered',
      'run.registered',
      'run.registered',
    ]);
    expect(received.slice(1).map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);

    await iterator.return?.();
    feed.dispose();
  });

  it('throws an invalid fromCursor from subscribe() itself and registers the live listener then', () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1' });
    expect(() => feed.feed.subscribe({ fromCursor: 'x' })).toThrow('Invalid cursor');
    feed.dispose();
  });

  it('positions the marker at the cursor the reader started from when it has been sent nothing', async () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1', liveBufferSize: 2 });
    const initial = feed.publish(new RunRegisteredEvent('run-0'))!;
    feed.publish(new RunRegisteredEvent('run-1'));
    const { iterator, parked } = await parkInLivePhase(
      (options) => feed.feed.subscribe({ ...options, fromCursor: initial.cursor }),
      1,
    );

    for (let index = 2; index <= 6; index += 1)
      feed.publish(new RunRegisteredEvent(`run-${index}`));

    const marker = await valueOf(parked);
    expect(marker).toMatchObject({
      sequence: 1,
      cursor: expect.stringMatching(/^[0-9a-f-]+:1$/),
      kind: FRAMES_DROPPED_KIND,
    });
    await iterator.return?.();
    feed.dispose();
  });

  it('resumes at the oldest retained event, not a throw, when the log has evicted past the overflow', async () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1', liveBufferSize: 2, maxEvents: 3 });
    feed.publish(new RunRegisteredEvent('run-0'));
    const { iterator, parked } = await parkInLivePhase(
      (options) => feed.feed.subscribe({ ...options, replayLimit: 2 }),
      1,
    );

    // Six arrive while the reader is parked; the log keeps only the last three.
    for (let index = 1; index <= 6; index += 1)
      feed.publish(new RunRegisteredEvent(`run-${index}`));

    const received = [
      await valueOf(parked),
      ...(await pullUntil(iterator, (events) => events.length >= 4)),
    ];
    expect(received.map((event) => event.kind)).toEqual([
      FRAMES_DROPPED_KIND,
      'feed.gap',
      'run.registered',
      'run.registered',
      'run.registered',
    ]);
    // Sequences 1-3 were evicted: the reader resumes at the oldest one left.
    expect(received.slice(2).map((event) => event.sequence)).toEqual([4, 5, 6]);

    await iterator.return?.();
    feed.dispose();
  });

  it('still enforces the replay limit on the first, cold replay', async () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1', liveBufferSize: 2 });
    for (let index = 0; index < 3; index += 1) feed.publish(new RunRegisteredEvent(`run-${index}`));

    const iterator = feed.feed.subscribe({ replayLimit: 2 })[Symbol.asyncIterator]();
    const failure = await rejectionOf(pullUntil(iterator, () => false));
    expect(failure).toMatchObject({ name: 'ReplayWindowExceededError' });
    feed.dispose();
  });

  it('reports nothing when the reader keeps up, unsubscribes, or the feed is disposed', async () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1', liveBufferSize: 2 });
    const controller = new AbortController();
    const iterator = feed.feed.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    const kinds: string[] = [];

    feed.publish(new RunRegisteredEvent('run-0'));
    const first = await valueOf(iterator.next());
    feed.publish(new RunRegisteredEvent('run-1'));
    const second = await valueOf(iterator.next());
    kinds.push(first.kind, second.kind);
    expect(kinds).toEqual(['run.registered', 'run.registered']);

    controller.abort();
    expect(await isDone(iterator.next())).toBe(true);

    const disposed = feed.feed.subscribe()[Symbol.asyncIterator]();
    const pending = disposed.next();
    feed.dispose();
    expect(await isDone(pending)).toBe(true);
  });

  it('delivers the marker even to a subscriber filtering by kind', async () => {
    const feed = createBureauEventFeed({ bureauId: 'bureau-1', liveBufferSize: 1 });
    const { iterator, parked } = await parkInLivePhase(
      (options) =>
        feed.feed.subscribe({
          ...options,
          filterEnvelope: (envelope: BureauEventEnvelope) => envelope.kind === 'run.registered',
        }),
      0,
    );
    feed.publish(new RunRegisteredEvent('run-0'));
    feed.publish(new RunRegisteredEvent('run-1'));
    feed.publish(new RunRegisteredEvent('run-2'));

    const received = [
      await valueOf(parked),
      ...(await pullUntil(iterator, (events) => events.length >= 3)),
    ];
    expect(received.map((event) => event.kind)).toEqual([
      FRAMES_DROPPED_KIND,
      'run.registered',
      'run.registered',
      'run.registered',
    ]);
    expect(received[0]).toMatchObject({ sequence: -1, cursor: '-1' });
    expect(received.slice(1).map((event) => event.sequence)).toEqual([0, 1, 2]);

    await iterator.return?.();
    feed.dispose();
  });
});

describe('the frames-dropped marker on the run event feed attachment', () => {
  it('delivers exactly one marker when a run subscriber overflows its buffer, then continues', async () => {
    const listeners = new Map<string, Set<(event: Event) => void>>();
    const activeRun = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, listener: (event: Event) => void) => {
        listeners.get(type)?.delete(listener);
      },
    };
    const feeds = new Map<string, AgentRunEventFeed>();
    const registry: MutableAgentRunEventRegistry = {
      get: (runId) => feeds.get(runId),
      set: (runId, feed) => {
        feeds.set(runId, feed);
      },
      delete: (runId) => {
        feeds.delete(runId);
      },
    };
    const emit = () => {
      for (const listener of listeners.get(RunStartedEvent.type) ?? []) {
        listener(new RunStartedEvent({} as never));
      }
    };

    attachRunEventFeed('run-1', activeRun as never, registry, { now: () => 3 });
    const feed = registry.get('run-1')!;
    expect(() => feed.feed.subscribe({ fromCursor: 'x' })).toThrow('Invalid cursor');
    emit();
    const { iterator, parked, replay } = await parkInLivePhase(
      (options) => feed.feed.subscribe(options),
      1,
    );
    expect(replay[0]).toMatchObject({ sequence: 0, runId: 'run-1' });

    // Weft's default live buffer holds 1000; this overflows it in one turn.
    for (let count = 0; count < 1_005; count += 1) emit();

    const received = [
      await valueOf(parked),
      ...(await pullUntil(iterator, (events) => events.length >= 1_005)),
    ];
    expect(received.filter((event) => event.kind === FRAMES_DROPPED_KIND)).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: FRAMES_DROPPED_KIND,
      runId: 'run-1',
      sequence: 0,
      cursor: expect.stringMatching(/^[0-9a-f-]+:0$/),
      emittedAtMs: 3,
    });
    expect(received.slice(1).map((event) => event.sequence)).toEqual(
      Array.from({ length: 1_005 }, (_, offset) => offset + 1),
    );

    await iterator.return?.();
    feed.dispose();
  });
});
