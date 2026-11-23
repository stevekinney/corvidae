/**
 * COR-2632: a fire the sample-world seed waits for is never missed. The seed sets the story's clock
 * to the instant a schedule comes due and waits for the run that fire starts. The engine's
 * scheduler reaches that occurrence on its next poll, and counts one it reaches more than a poll
 * interval and a second late as missed, starting no run; so on a running clock, an event loop that
 * stalls past that grace before the poll left the seed waiting for a run that never came, and the
 * e2e server never said it was ready. The stall is injected here as real time the offset clock's
 * own real clock is moved past, at once, before any poll can land: a running clock misses the
 * fire, and one held by {@link fireScheduleAt} still starts it.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitUntil } from '@lostgradient/testing/wait-until';

import { startHost, type Host } from '../src/host/host.ts';
import { createOffsetRuntime, type OffsetRuntime } from '../src/host/offset-runtime.ts';
import { showcaseBuiltInAgents } from '../src/host/showcase-agents.ts';
import { engineRuns, fireScheduleAt } from './sample-world-host.ts';

/** 7:59 AM CDT on Oct 23, 2026, a minute before the schedule below comes due. */
const SEVEN_FIFTY_NINE = Date.parse('2026-10-23T07:59:00-05:00');
/** 8:00 AM CDT on Oct 23, when `0 8 * * *` in Chicago comes due. */
const EIGHT = Date.parse('2026-10-23T08:00:00-05:00');
/**
 * Real time that passes between the jump to the fire and the scheduler's poll: past the engine's
 * default poll interval (one second) and its one-second grace together, as a stalled event loop
 * lets it.
 */
const STALL_MILLISECONDS = 2_500;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A host on an offset clock at 7:59 AM whose real clock the test can move on, and its schedule. */
async function hostWithEightOClockSchedule(): Promise<{
  readonly host: Host;
  readonly runtime: OffsetRuntime;
  readonly scheduleId: string;
  /** Moves the offset clock's real clock on, as real time passing without the test waiting. */
  readonly stall: () => void;
}> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-schedule-fire-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  let skew = 0;
  const runtime = createOffsetRuntime(SEVEN_FIFTY_NINE, { realNow: () => Date.now() + skew });
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    runtime,
    extraAgents: showcaseBuiltInAgents(),
  });
  cleanups.push(() => host.close());
  const schedule = await host.bureau.schedules.create({
    agentName: 'assistant',
    input: 'Summarize yesterday.',
    spec: '0 8 * * *',
    timeZone: 'America/Chicago',
  });
  if (schedule === undefined) throw new Error('The host composed no durable engine.');
  expect(schedule.nextFireAt).toBe(EIGHT);
  return {
    host,
    runtime,
    scheduleId: schedule.id,
    stall: () => {
      skew += STALL_MILLISECONDS;
    },
  };
}

/** The runs the schedule's fires started. */
async function firesOf(host: Host): Promise<number> {
  const runs = await engineRuns(host);
  return runs.filter((run) => (run.tags ?? []).includes('origin:schedule')).length;
}

test('on a running clock, a stall past the grace after the jump to the fire misses it', async () => {
  const { host, runtime, scheduleId, stall } = await hostWithEightOClockSchedule();
  runtime.setTime(EIGHT);
  stall();
  await waitUntil(
    async () => {
      const missed = await host.bureau.schedules.missed(scheduleId);
      return (missed ?? []).some((fire) => fire.reason === 'late' && fire.occurrence === EIGHT);
    },
    { message: 'the 8:00 AM fire to be counted missed' },
  );
  // This is the seed's hang: the run it would wait for was never started.
  expect(await firesOf(host)).toBe(0);
});

test('a clock held at the fire starts it however late the scheduler polls', async () => {
  const { host, runtime, scheduleId, stall } = await hostWithEightOClockSchedule();
  let stalled = false;
  await fireScheduleAt(
    runtime,
    EIGHT,
    async () => {
      // The same stall, once the clock is held and before any poll can land.
      if (!stalled) {
        stalled = true;
        stall();
      }
      return (await firesOf(host)) > 0;
    },
    'the 8:00 AM fire to start its run',
  );
  expect(await host.bureau.schedules.missed(scheduleId)).toEqual([]);
});
