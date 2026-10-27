/**
 * COR-1594 — a schedule fire's end reaches a `bureau.tasks.events` subscriber on a Bureau that did
 * not settle it. Two Bureaus open one SQLite database under `workflow-lease` ownership: one runs
 * the fire, the other serves the stream.
 *
 * Nothing here waits on a wall clock (see `schedule-fire-stream.test-support.ts`).
 */
import { type GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, it, jest } from 'bun:test';

import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  createScheduleFireHarness,
  fireOnce,
  pollUntil,
} from './schedule-fire-fixtures.test-support';
import {
  advanceFeedPoll,
  driveUntil,
  forgetDrivenRuntimes,
  fireBureauOptions,
  followFire,
  parkedGenerate,
  settledEventsOf,
} from './schedule-fire-stream.test-support';
import { SCHEDULE_FIRE_SETTLED_EVENT_KIND } from './schedule-fire-settled-event';
import type { Bureau } from './types';

const harness = createScheduleFireHarness();

afterEach(async () => {
  forgetDrivenRuntimes();
  jest.useRealTimers();
  await harness.dispose();
});

/** A holder that runs a fire parked on `gate`, and a peer that serves a stream of it. */
async function holderAndPeer(generate: GenerateFunction) {
  jest.useFakeTimers();
  const path = harness.nextDatabasePath();
  const holder = await harness.open({
    ...fireBureauOptions(generate, 'holder'),
    storage: await harness.sqliteStorage(path),
  });
  const peer = await harness.open({
    ...fireBureauOptions(generate, 'peer'),
    storage: await harness.sqliteStorage(path),
  });
  return { holder, peer };
}

describe('a fire settled on another Bureau ends the stream this one serves', () => {
  for (const [name, outcome] of [
    ['completed', 'all done'],
    ['failed', new Error('the model failed')],
  ] as const) {
    it(`delivers exactly one terminal status for a fire that ${name}, and ends`, async () => {
      const gate = Promise.withResolvers<void>();
      const parked = Promise.withResolvers<void>();
      const generate: GenerateFunction = async () => {
        parked.resolve();
        await gate.promise;
        if (outcome instanceof Error) throw outcome;
        return { content: outcome, toolCalls: [] };
      };
      const { holder, peer } = await holderAndPeer(generate);
      const { fireId } = await fireOnce(holder, OWNER.alice);
      await parked.promise;
      const stream = await followFire(peer, fireId);
      // The stream has opened and has nothing to say yet.
      await advanceFeedPoll();
      expect(stream.ended).toBe(false);

      gate.resolve();
      await driveUntil(() => stream.ended, 'the peer stream to end');
      const frames = await stream.frames;

      expect(frames.map((frame) => frame.event)).toEqual(['task.snapshot', 'task.status']);
      expect(frames.map((frame) => (frame.data as { status?: string }).status)).toEqual([
        'working',
        name,
      ]);
      expect(await settledEventsOf(holder, fireId)).toHaveLength(1);
    });
  }

  it('records the end of a fire once, however many times it is settled', async () => {
    const generate: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });
    const { holder, peer } = await holderAndPeer(generate);
    const { fireId } = await fireOnce(holder, OWNER.alice);
    await pollUntil(async () => {
      const view = await peer.internals.taskRegistry.get(fireId);
      return view?.status === 'completed' ? true : undefined;
    }, 'the fire to settle');
    await pollUntil(async () => {
      const recorded = await settledEventsOf(peer, fireId);
      return recorded.length === 1 ? true : undefined;
    }, 'the settled event');

    // A second settlement, as the recovery of a fire whose process died would make.
    await peer.internals.taskRegistry.recordSettled(fireId, {
      at: new Date().toISOString(),
      status: 'completed',
      finishReason: null,
      message: null,
    });

    const events = await settledEventsOf(peer, fireId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ runId: fireId, status: 'completed' });
  });

  it('ends at once for a fire that is already over when the stream opens', async () => {
    const generate: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });
    const { holder, peer } = await holderAndPeer(generate);
    const { fireId } = await fireOnce(holder, OWNER.alice);
    await pollUntil(async () => {
      const view = await peer.internals.taskRegistry.get(fireId);
      return view?.status === 'completed' ? true : undefined;
    }, 'the fire to settle');

    const stream = await followFire(peer, fireId);
    await driveUntil(() => stream.ended, 'the stream of a settled fire to end');
    const frames = await stream.frames;

    expect(frames.map((frame) => (frame.data as { status?: string }).status)).toEqual([
      'completed',
      'completed',
    ]);
  });
});

type Captured = { owner: string; subscription: { readonly closed: boolean } };

/** Records each history subscription a Bureau's streams open. */
function captureSubscriptions(bureau: Bureau): Captured[] {
  const captured: Captured[] = [];
  const original = bureau.subscribeEventHistory.bind(bureau);
  (bureau as { subscribeEventHistory: Bureau['subscribeEventHistory'] }).subscribeEventHistory = (
    owner,
    listener,
    options,
  ) => {
    const subscription = original(owner, listener, options);
    captured.push({ owner: `${owner.kind}:${owner.id}`, subscription });
    return subscription;
  };
  return captured;
}

describe('the fire stream closes the history subscription it opens, however it ends', () => {
  it('when the history ends it on a peer', async () => {
    const { gate, parked, generate } = parkedGenerate();
    const { holder, peer } = await holderAndPeer(generate);
    const captured = captureSubscriptions(peer);
    const { fireId } = await fireOnce(holder, OWNER.alice);
    await parked.promise;
    const stream = await followFire(peer, fireId);
    await advanceFeedPoll();
    const mine = captured.filter((entry) => entry.owner === `run:${fireId}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.subscription.closed).toBe(false);

    gate.resolve();
    await driveUntil(() => stream.ended, 'the peer stream to end');
    await stream.frames;
    await advanceFeedPoll();

    expect(mine[0]?.subscription.closed).toBe(true);
  });

  it('when the client goes away before the fire settles', async () => {
    const { gate, parked, generate } = parkedGenerate();
    const { holder, peer } = await holderAndPeer(generate);
    const captured = captureSubscriptions(peer);
    const { fireId } = await fireOnce(holder, OWNER.alice);
    await parked.promise;
    const stream = await followFire(peer, fireId, 1);
    await driveUntil(() => stream.ended, 'the client to stop reading');
    await advanceFeedPoll();
    await advanceFeedPoll();

    const mine = captured.filter((entry) => entry.owner === `run:${fireId}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.subscription.closed).toBe(true);
    gate.resolve();
  });

  it('when the settling Bureau ends it through its own announcement', async () => {
    const { gate, parked, generate } = parkedGenerate();
    const { holder } = await holderAndPeer(generate);
    const captured = captureSubscriptions(holder);
    const { fireId } = await fireOnce(holder, OWNER.alice);
    await parked.promise;
    const stream = await followFire(holder, fireId);
    await advanceFeedPoll();

    gate.resolve();
    await driveUntil(() => stream.ended, 'the holder stream to end');
    const frames = await stream.frames;
    await advanceFeedPoll();

    const mine = captured.filter((entry) => entry.owner === `run:${fireId}`);
    expect(frames.map((frame) => frame.event)).toEqual(['task.snapshot', 'task.status']);
    expect(mine[0]?.subscription.closed).toBe(true);
    expect(await settledEventsOf(holder, fireId)).toHaveLength(1);
    expect(SCHEDULE_FIRE_SETTLED_EVENT_KIND).toBe('schedule.fire.settled');
  });
});
