/**
 * COR-1594, correction 3 — a fire's `bureau.tasks.events` stream reacts whenever its history
 * subscription can no longer be trusted to deliver: a transient read fault closes the subscription
 * for good, and a retention gap says events were lost, possibly the fire's own settled event. In
 * both the stream reads the record again, finishes if the fire is over, and otherwise ends with an
 * error so the client reconnects.
 *
 * Nothing here waits on a wall clock (see `schedule-fire-stream.test-support.ts`).
 */
import type { DurableEventEnvelope } from '@lostgradient/operative';
import { afterEach, describe, expect, it, jest } from 'bun:test';

import { DURABLE_HISTORY_GAP_KIND } from './durable-event-history';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  createScheduleFireHarness,
  failingFeedRead,
  fireOnce,
  holdingWrites,
  pollUntil,
} from './schedule-fire-fixtures.test-support';
import { SCHEDULE_FIRE_SETTLED_EVENT_KIND } from './schedule-fire-settled-event';
import {
  advanceFeedPoll,
  driveUntil,
  fireBureauOptions,
  followFire,
  parkedGenerate,
} from './schedule-fire-stream.test-support';
import type { Bureau } from './types';

const harness = createScheduleFireHarness();

afterEach(async () => {
  jest.useRealTimers();
  await harness.dispose();
});

const statusesOf = (frames: readonly { data?: unknown }[]) =>
  frames.map((frame) => (frame.data as { status?: string }).status);

async function settled(bureau: Bureau, fireId: string): Promise<void> {
  await pollUntil(async () => {
    const view = await bureau.tasks.get(fireId);
    return view?.status === 'completed' ? true : undefined;
  }, 'the settlement to be readable');
}

/** The listener each fire-history subscription of `bureau` was opened with. */
function captureListeners(bureau: Bureau) {
  const listeners: Array<(event: DurableEventEnvelope) => void> = [];
  const original = bureau.subscribeEventHistory.bind(bureau);
  (bureau as { subscribeEventHistory: Bureau['subscribeEventHistory'] }).subscribeEventHistory = (
    owner,
    listener,
    options,
  ) => {
    listeners.push(listener);
    return original(owner, listener, options);
  };
  return listeners;
}

const gapEvent = (fireId: string): DurableEventEnvelope =>
  ({
    owner: { kind: 'run', id: fireId },
    kind: DURABLE_HISTORY_GAP_KIND,
    cursor: '5',
    emittedAtMs: 0,
    payload: { requestedCursor: '2', firstRetainedCursor: '6' },
  }) as unknown as DurableEventEnvelope;

describe('a peer stream whose history subscription is closed by a read fault', () => {
  it('finishes with the settled status when the fire is over', async () => {
    jest.useFakeTimers();
    const { gate, parked, generate } = parkedGenerate();
    const path = harness.nextDatabasePath();
    const fault = failingFeedRead();
    const holder = await harness.open({
      ...fireBureauOptions(generate, 'holder'),
      storage: await harness.sqliteStorage(path),
    });
    const peer = await harness.open({
      ...fireBureauOptions(generate, 'peer'),
      storage: await harness.sqliteStorage(path, (storage) => fault.wrap(storage)),
    });
    const { fireId } = await fireOnce(holder, OWNER.alice);
    await parked.promise;
    const stream = await followFire(peer, fireId);
    await advanceFeedPoll();
    expect(stream.ended).toBe(false);

    // The fire ends while the peer's tail is about to fail: the settled event is never delivered.
    fault.arm();
    gate.resolve();
    await settled(peer, fireId);
    await driveUntil(() => stream.ended, 'the peer stream to end');
    const frames = await stream.frames;

    expect(fault.failed).toBe(1);
    expect(statusesOf(frames)).toEqual(['working', 'completed']);
  });

  it('ends with an error, so the client reconnects, when the fire is not over', async () => {
    jest.useFakeTimers();
    const { gate, parked, generate } = parkedGenerate();
    const path = harness.nextDatabasePath();
    const fault = failingFeedRead();
    const holder = await harness.open({
      ...fireBureauOptions(generate, 'holder'),
      storage: await harness.sqliteStorage(path),
    });
    const peer = await harness.open({
      ...fireBureauOptions(generate, 'peer'),
      storage: await harness.sqliteStorage(path, (storage) => fault.wrap(storage)),
    });
    const { fireId } = await fireOnce(holder, OWNER.alice);
    await parked.promise;
    const stream = await followFire(peer, fireId);
    await advanceFeedPoll();

    fault.arm();
    await driveUntil(() => stream.ended, 'the peer stream to end');
    const outcome = await stream.frames.then(
      (frames) => ({ frames }),
      (error: unknown) => ({ error }),
    );

    expect(fault.failed).toBe(1);
    // The client saw the snapshot, and then the stream closed without a terminal status.
    const frames = 'frames' in outcome ? outcome.frames : [];
    expect(statusesOf(frames)).not.toContain('completed');
    gate.resolve();
  });
});

describe('a peer stream that is told of a gap in the history', () => {
  it('reads the record again and finishes when the fire is already over', async () => {
    jest.useFakeTimers();
    const { gate, parked, generate } = parkedGenerate();
    const path = harness.nextDatabasePath();
    const hold = holdingWrites(SCHEDULE_FIRE_SETTLED_EVENT_KIND);
    harness.onDispose(() => hold.release());
    const holder = await harness.open({
      ...fireBureauOptions(generate, 'holder'),
      storage: await harness.sqliteStorage(path, (storage) => hold.wrap(storage)),
    });
    const peer = await harness.open({
      ...fireBureauOptions(generate, 'peer'),
      storage: await harness.sqliteStorage(path),
    });
    const listeners = captureListeners(peer);
    const { fireId } = await fireOnce(holder, OWNER.alice);
    await parked.promise;
    const stream = await followFire(peer, fireId);
    await advanceFeedPoll();
    expect(stream.ended).toBe(false);

    // The settled event never lands (the holder is held at its append), as when retention retired it.
    hold.arm();
    gate.resolve();
    await hold.reached;
    await settled(peer, fireId);
    for (let poll = 0; poll < 5; poll += 1) await advanceFeedPoll();
    expect(stream.ended).toBe(false);

    for (const listener of listeners) listener(gapEvent(fireId));
    await driveUntil(() => stream.ended, 'the peer stream to end');
    const frames = await stream.frames;

    expect(statusesOf(frames)).toEqual(['working', 'completed']);
  });
});
