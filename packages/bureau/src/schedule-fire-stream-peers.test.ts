/**
 * COR-1594 — a schedule fire's end reaches a `bureau.tasks.events` subscriber on a Bureau that did
 * not settle it. Two Bureaus open one SQLite database under `workflow-lease` ownership: one runs
 * the fire, the other serves the stream.
 *
 * Nothing here waits on a wall clock. Each Bureau runs on a manual runtime, and the history feed's
 * live poll, which is a raw `setTimeout` the runtime does not own, runs on Bun's fake timers and is
 * driven a poll interval at a time.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { stopWhen, type GenerateFunction } from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it, jest } from 'bun:test';

import { SCHEDULE_FIRE_SETTLED_EVENT_KIND } from './schedule-fire-settled-event';
import {
  OWNER,
  readFrames,
  subscribeRequest,
} from './http/management/management-fixtures.test-support.ts';
import {
  createScheduleFireHarness,
  fireOnce,
  handlerOf,
  pollUntil,
} from './schedule-fire-fixtures.test-support';
import type { Bureau } from './types';

const harness = createScheduleFireHarness();

afterEach(async () => {
  jest.useRealTimers();
  await harness.dispose();
});

const OWNERSHIP = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 30_000,
  workflowClaimRenewIntervalMs: 25,
} as const;

/** The history feed's live poll interval, which the fake clock is advanced by. */
const FEED_POLL_MILLISECONDS = 100;

/** Lets work that waits on the fake clock make progress: one poll interval, then a few turns. */
async function advanceFeedPoll(): Promise<void> {
  jest.advanceTimersByTime(FEED_POLL_MILLISECONDS);
  for (let turn = 0; turn < 5; turn += 1) await yieldToPortableEventLoop();
}

/** Drives the fake clock until `done()`, or fails after a bounded number of polls. */
async function driveUntil(done: () => boolean, what: string): Promise<void> {
  for (let poll = 0; poll < 200; poll += 1) {
    if (done()) return;
    await advanceFeedPoll();
  }
  throw new Error(`Condition was not met: ${what}`);
}

async function settledEventsOf(bureau: Bureau, fireId: string) {
  const page = await bureau.eventHistory({ kind: 'run', id: fireId });
  if (!('events' in page)) return [];
  return page.events.filter((event) => event.kind === SCHEDULE_FIRE_SETTLED_EVENT_KIND);
}

/** A holder that runs a fire parked on `gate`, and a peer that serves a stream of it. */
async function holderAndPeer(generate: GenerateFunction) {
  jest.useFakeTimers();
  const path = harness.nextDatabasePath();
  const options = {
    generate,
    stopWhen: stopWhen.noToolCalls(),
    durableOwnership: OWNERSHIP,
    durableBackgroundTasks: 'manual' as const,
  };
  const holder = await harness.open({
    ...options,
    runtime: createManualRuntimeServices({ identifierSeed: 'holder' }),
    storage: await harness.sqliteStorage(path),
  });
  const peer = await harness.open({
    ...options,
    runtime: createManualRuntimeServices({ identifierSeed: 'peer' }),
    storage: await harness.sqliteStorage(path),
  });
  return { holder, peer };
}

/** Follows a fire's stream on `bureau`, resolving its frames once the stream has ended. */
async function followFire(bureau: Bureau, fireId: string) {
  let ended = false;
  const frames = readFrames(
    await handlerOf(bureau)(
      subscribeRequest('bureau.tasks.events', { taskId: fireId }, 'alice-key'),
    ),
    { timeoutMs: 30_000 },
  ).finally(() => {
    ended = true;
  });
  frames.catch(() => undefined);
  return {
    frames,
    get ended(): boolean {
      return ended;
    },
  };
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
      const view = await peer.tasks.get(fireId);
      return view?.status === 'completed' ? true : undefined;
    }, 'the fire to settle');
    await pollUntil(async () => {
      const recorded = await settledEventsOf(peer, fireId);
      return recorded.length === 1 ? true : undefined;
    }, 'the settled event');

    // A second settlement, as the recovery of a fire whose process died would make.
    await peer.tasks.recordSettled(fireId, {
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
      const view = await peer.tasks.get(fireId);
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
