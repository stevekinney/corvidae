/**
 * COR-1594, correction 1 — a fire's end reaches every open peer stream, including when the
 * `schedule.fire.settled` append failed, when the settling process died between the settlement and
 * the append, and when the fire was cancelled by a process that holds no run for it.
 *
 * Nothing here waits on a wall clock (see `schedule-fire-stream.test-support.ts`).
 */
import type { Storage } from '@lostgradient/weft';
import { afterEach, describe, expect, it, jest } from 'bun:test';

import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  createScheduleFireHarness,
  failingWrites,
  fireOnce,
  holdingWrites,
  pollUntil,
} from './schedule-fire-fixtures.test-support';
import { SCHEDULE_FIRE_SETTLED_EVENT_KIND } from './schedule-fire-settled-event';
import {
  advanceFeedPoll,
  driveUntil,
  forgetDrivenRuntimes,
  fireBureauOptions,
  followFire,
  parkedGenerate,
  settledEventsOf,
} from './schedule-fire-stream.test-support';
import type { Bureau } from './types';

const harness = createScheduleFireHarness();

afterEach(async () => {
  forgetDrivenRuntimes();
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

describe('a rejected append of the settled event', () => {
  it('is tried again, so a peer stream that was open across it ends', async () => {
    jest.useFakeTimers();
    const { gate, parked, generate } = parkedGenerate();
    const path = harness.nextDatabasePath();
    const fault = failingWrites(SCHEDULE_FIRE_SETTLED_EVENT_KIND, 1);
    const holder = await harness.open({
      ...fireBureauOptions(generate, 'holder'),
      storage: await harness.sqliteStorage(path, (storage) => fault.wrap(storage)),
    });
    const peer = await harness.open({
      ...fireBureauOptions(generate, 'peer'),
      storage: await harness.sqliteStorage(path),
    });
    const { fireId } = await fireOnce(holder, OWNER.alice);
    await parked.promise;
    const stream = await followFire(peer, fireId);
    await advanceFeedPoll();
    expect(stream.ended).toBe(false);

    gate.resolve();
    await driveUntil(() => stream.ended, 'the peer stream to end');
    const frames = await stream.frames;

    expect(fault.failed).toBe(1);
    expect(statusesOf(frames)).toEqual(['working', 'completed']);
    expect(await settledEventsOf(holder, fireId)).toHaveLength(1);
  });
});

describe('a process that dies between the settlement and the append', () => {
  it('leaves the event to the next boot, which ends the open peer stream once', async () => {
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
    const { fireId } = await fireOnce(holder, OWNER.alice);
    await parked.promise;
    const stream = await followFire(peer, fireId);
    await advanceFeedPoll();

    hold.arm();
    gate.resolve();
    await hold.reached;
    await settled(peer, fireId);
    // The holder is dead at its append: the stream open across the window hears nothing.
    for (let poll = 0; poll < 20; poll += 1) await advanceFeedPoll();
    expect(stream.ended).toBe(false);
    expect(await settledEventsOf(peer, fireId)).toHaveLength(0);

    // The next boot, on the same store, finds a settled fire whose event was never appended.
    await harness.open({
      ...fireBureauOptions(generate, 'restart'),
      storage: await harness.sqliteStorage(path),
    });
    await driveUntil(() => stream.ended, 'the peer stream to end after the next boot');
    const frames = await stream.frames;

    expect(statusesOf(frames)).toEqual(['working', 'completed']);
    expect(await settledEventsOf(peer, fireId)).toHaveLength(1);

    // A boot after that finds the event and appends nothing.
    const again = await harness.open({
      ...fireBureauOptions(generate, 'restart-again'),
      storage: await harness.sqliteStorage(path),
    });
    await advanceFeedPoll();
    expect(await settledEventsOf(again, fireId)).toHaveLength(1);

    // The dead holder's append is let go, so it ends before its store is closed: it finds the
    // event already there and writes nothing.
    hold.release();
    await advanceFeedPoll();
    expect(await settledEventsOf(again, fireId)).toHaveLength(1);
  });
});

describe('a fire cancelled by a process that holds no run for it', () => {
  it('ends a peer stream that was open across the cancel', async () => {
    jest.useFakeTimers();
    const { gate, parked, generate } = parkedGenerate();
    const path = harness.nextDatabasePath();
    const holder = await harness.open({
      ...fireBureauOptions(generate, 'holder'),
      storage: await harness.sqliteStorage(path),
    });
    const watcher = await harness.open({
      ...fireBureauOptions(generate, 'watcher'),
      storage: await harness.sqliteStorage(path),
    });
    const canceller = await harness.open({
      ...fireBureauOptions(generate, 'canceller'),
      storage: await harness.sqliteStorage(path),
    });
    const { fireId } = await fireOnce(holder, OWNER.alice);
    await parked.promise;
    const stream = await followFire(watcher, fireId);
    await advanceFeedPoll();
    expect(stream.ended).toBe(false);

    const receipt = await canceller.tasks.cancel(fireId, 0);
    expect(receipt).toEqual({ receipt: 'canceled' });
    await driveUntil(() => stream.ended, 'the watcher stream to end');
    const frames = await stream.frames;
    gate.resolve();

    expect(statusesOf(frames)).toEqual(['working', 'canceled']);
    expect(await settledEventsOf(canceller, fireId)).toHaveLength(1);
  });
});

/** Fails the first read of a fire's settled-event deduplication marker, as a storage fault does. */
function failingSettledMarkerRead(storage: Storage): Storage {
  let armed = true;
  return new Proxy(storage, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== 'function') return member;
      const call = (...args: unknown[]) =>
        (member as (...a: unknown[]) => unknown).apply(target, args);
      if (property !== 'get') return call;
      return (key: string, ...rest: unknown[]) => {
        if (
          armed &&
          key.startsWith('outbox-dedupe:') &&
          key.includes(SCHEDULE_FIRE_SETTLED_EVENT_KIND)
        ) {
          armed = false;
          return Promise.reject(new Error('transient storage error on the marker read'));
        }
        return call(key, ...rest);
      };
    },
  });
}

describe('a boot whose announcement of settled fires cannot read', () => {
  it('reports that pass and goes on with the rest of the boot', async () => {
    const { gate, parked, generate } = parkedGenerate();
    const path = harness.nextDatabasePath();
    const holder = await harness.open({
      ...fireBureauOptions(generate, 'holder'),
      storage: await harness.sqliteStorage(path),
    });
    const { fireId } = await fireOnce(holder, OWNER.alice);
    await parked.promise;
    gate.resolve();
    await settled(holder, fireId);
    await pollUntil(async () => {
      const events = await settledEventsOf(holder, fireId);
      return events.length === 1 ? true : undefined;
    }, 'the settled event');
    await holder.dispose();

    // The next boot's pass fails at its first marker read. It is reported as that pass's failure,
    // not as the task reconciliation's, so the steps after it in that reconciliation still ran.
    const messages: string[] = [];
    await harness.open({
      ...fireBureauOptions(generate, 'restart'),
      storage: await harness.sqliteStorage(path, failingSettledMarkerRead),
      onDiagnostic: (diagnostic) => {
        messages.push(diagnostic.message);
      },
    });
    await pollUntil(
      () =>
        messages.some((message) =>
          message.includes('Could not announce the ends of settled schedule fires at boot'),
        )
          ? true
          : undefined,
      'the pass to report its failure',
    );
    expect(messages.some((message) => message.includes('Could not reconcile task records'))).toBe(
      false,
    );
  });
});
