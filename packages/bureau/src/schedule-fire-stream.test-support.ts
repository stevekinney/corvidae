/**
 * Fixtures for the tests of a schedule fire's `bureau.tasks.events` stream across Bureaus that share
 * a store (COR-1594). Nothing waits on a wall clock: each Bureau runs on a manual runtime, and the
 * history feed's live poll, a raw `setTimeout` the runtime does not own, runs on Bun's fake timers and
 * is driven a poll interval at a time.
 */
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, stopWhen, type GenerateFunction } from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { jest } from 'bun:test';

import {
  readFrames,
  subscribeRequest,
} from './http/management/management-fixtures.test-support.ts';
import { handlerOf } from './schedule-fire-fixtures.test-support';
import { SCHEDULE_FIRE_SETTLED_EVENT_KIND } from './schedule-fire-settled-event';
import type { Bureau, BureauOptions } from './types';

export const OWNERSHIP = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 30_000,
  workflowClaimRenewIntervalMs: 25,
} as const;

/** The history feed's live poll interval, which the fake clock is advanced by. */
const FEED_POLL_MILLISECONDS = 100;

/**
 * The manual runtimes of the Bureaus `fireBureauOptions` configured. A retry a Bureau makes waits on
 * its runtime's timers, which a manual runtime fires only when advanced, so each poll advances them.
 */
const drivenRuntimes = new Set<ManualRuntimeServices>();

/** Stops advancing the runtimes of Bureaus a finished test opened. Call it after each test. */
export function forgetDrivenRuntimes(): void {
  drivenRuntimes.clear();
}

/**
 * Lets work that waits on the fake clock make progress: one poll interval on it and on the
 * Bureaus' runtimes, then a few turns.
 */
export async function advanceFeedPoll(): Promise<void> {
  jest.advanceTimersByTime(FEED_POLL_MILLISECONDS);
  for (const runtime of drivenRuntimes) await runtime.advance(FEED_POLL_MILLISECONDS);
  for (let turn = 0; turn < 5; turn += 1) await yieldToPortableEventLoop();
}

/** Drives the fake clock until `done()`, or fails after a bounded number of polls. */
export async function driveUntil(done: () => boolean, what: string): Promise<void> {
  for (let poll = 0; poll < 200; poll += 1) {
    if (done()) return;
    await advanceFeedPoll();
  }
  throw new Error(`Condition was not met: ${what}`);
}

export async function settledEventsOf(bureau: Bureau, fireId: string) {
  const page = await bureau.eventHistory({ kind: 'run', id: fireId });
  if (!('events' in page)) return [];
  return page.events.filter((event) => event.kind === SCHEDULE_FIRE_SETTLED_EVENT_KIND);
}

/** The options of a Bureau that runs fires on `generate`, on a manual runtime named `seed`. */
export function fireBureauOptions(
  generate: GenerateFunction,
  seed: string,
): Pick<BureauOptions, 'durableOwnership' | 'durableBackgroundTasks' | 'runtime' | 'agents'> {
  const runtime = createManualRuntimeServices({ identifierSeed: seed });
  drivenRuntimes.add(runtime);
  return {
    agents: { default: createAgent({ generate, stopWhen: stopWhen.noToolCalls() }) },
    durableOwnership: OWNERSHIP,
    durableBackgroundTasks: 'manual',
    runtime,
  };
}

/** A generate that parks on `gate` and reports on `parked` once a fire is running on it. */
export function parkedGenerate() {
  const gate = Promise.withResolvers<void>();
  const parked = Promise.withResolvers<void>();
  const generate: GenerateFunction = async () => {
    parked.resolve();
    await gate.promise;
    return { content: 'all done', toolCalls: [] };
  };
  return { gate, parked, generate };
}

/** Follows a fire's stream on `bureau`; `stopAfter` leaves it after that many frames. */
export async function followFire(bureau: Bureau, fireId: string, stopAfter?: number) {
  let ended = false;
  const frames = readFrames(
    await handlerOf(bureau)(
      subscribeRequest('bureau.tasks.events', { taskId: fireId }, 'alice-key'),
    ),
    {
      ...(stopAfter === undefined ? {} : { stop: (read) => read.length >= stopAfter }),
    },
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
