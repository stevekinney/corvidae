import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { KEYS } from '../../storage/keys.ts';
import { decode, encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { ScheduleMissedFireEvent } from '../events/schedule-events.ts';
import type { ScheduleSummary, WorkflowServicesResolverScheduleInfo } from '../types.ts';
import { ScheduleOccurrenceNotNextError } from './schedule-occurrence-not-next-error.ts';
import {
  drainEngine,
  registerWorkflow,
  releaseRunningWorkflows,
  tickEngine,
  type Clock,
} from './schedule.test-support.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';

// A person can skip the next run of a schedule and start one now (COR-1829). Every test drives the
// engine's injected clock; nothing waits.

const LOS_ANGELES = 'America/Los_Angeles';

function at(iso: string): number {
  return Date.parse(iso);
}

function isoOf(timestamp: number | null | undefined): string | null {
  return timestamp === null || timestamp === undefined ? null : new Date(timestamp).toISOString();
}

type Opened = {
  engine: Engine;
  clock: Clock;
  /** When each run began, in start order. */
  runs: string[];
  /** The schedule info the services resolver was given for each scheduled run. */
  resolved: Array<WorkflowServicesResolverScheduleInfo | undefined>;
};

/** An engine whose clock starts at `start`; its `report` workflow records when it began. */
function open(start: string, options: { hold?: boolean; storage?: Storage } = {}): Opened {
  const clock: Clock = { now: at(start) };
  const runs: string[] = [];
  const resolved: Array<WorkflowServicesResolverScheduleInfo | undefined> = [];
  const engine = new Engine({
    storage: options.storage ?? new MemoryStorage(),
    getNow: () => clock.now,
    resolveWorkflowServices: async (info) => {
      resolved.push(info.schedule);
      return { status: 'available', services: {} };
    },
  });
  registerWorkflow(engine, 'report', async function* (ctx) {
    runs.push(new Date(clock.now).toISOString());
    if (options.hold === true) yield* ctx.waitForSignal('release');
    return 'done';
  });
  return { engine, clock, runs, resolved };
}

/** One field of a schedule's current summary. */
async function fieldOf<K extends keyof ScheduleSummary>(
  engine: Engine,
  id: string,
  key: K,
): Promise<ScheduleSummary[K]> {
  const summary = await engine.getSchedule(id);
  if (summary === null) throw new Error(`Schedule "${id}" does not exist`);
  return summary[key];
}

async function summaryOf(engine: Engine, id: string): Promise<ScheduleSummary> {
  const summary = await engine.getSchedule(id);
  if (summary === null) throw new Error(`Schedule "${id}" does not exist`);
  return summary;
}

describe('skipping the next occurrence', () => {
  let opened: Opened | undefined;

  afterEach(() => {
    opened?.engine[Symbol.dispose]();
    opened = undefined;
  });

  it('skips exactly one fire and runs the one after it', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    await engine.skipNextScheduleOccurrence('daily');
    const skipped = await summaryOf(engine, 'daily');
    expect(isoOf(skipped.skipUntil)).toBe('2026-01-01T09:00:00.000Z');
    // A skip is bookkeeping, as a fire is: the schedule's own revision stays where it was.
    expect(skipped.revision).toBe(1);

    await tickEngine(engine, clock, at('2026-01-01T09:00:00.000Z'));
    expect(runs).toEqual([]);
    const afterSkip = await summaryOf(engine, 'daily');
    expect(afterSkip.skipUntil).toBeUndefined();
    expect(afterSkip.lastFireAt).toBeUndefined();
    expect(afterSkip.missedFireCount).toBe(0);
    expect(isoOf(afterSkip.nextFireAt)).toBe('2026-01-02T09:00:00.000Z');

    await tickEngine(engine, clock, at('2026-01-02T09:00:00.000Z'));
    expect(runs).toEqual(['2026-01-02T09:00:00.000Z']);
  });

  it('skips an interval schedule’s next fire', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, { every: '1h' }, { id: 'hourly' });

    await engine.skipNextScheduleOccurrence('hourly');
    await tickEngine(engine, clock, at('2026-01-01T01:00:00.000Z'));
    await tickEngine(engine, clock, at('2026-01-01T02:00:00.000Z'));

    expect(runs).toEqual(['2026-01-01T02:00:00.000Z']);
  });

  it('skips the following actual fire when nextFireAt is the end of a gap that fires nothing', async () => {
    opened = open('2026-03-07T11:00:00.000Z');
    const { engine, clock, runs } = opened;
    const missed: ScheduleMissedFireEvent[] = [];
    engine.addEventListener(ScheduleMissedFireEvent.type, (event) => {
      missed.push(event);
    });
    await engine.schedule('report', null, '30 2 * * *', { id: 'daily', timeZone: LOS_ANGELES });
    expect(isoOf(await fieldOf(engine, 'daily', 'nextFireAt'))).toBe('2026-03-08T10:00:00.000Z');

    await engine.skipNextScheduleOccurrence('daily');
    const skipped = await summaryOf(engine, 'daily');
    expect(isoOf(skipped.skipUntil)).toBe('2026-03-09T09:30:00.000Z');
    expect(isoOf(skipped.nextFireAt)).toBe('2026-03-08T10:00:00.000Z');

    // The gap's end is not a fire, so it neither spends the skip nor starts a run.
    await tickEngine(engine, clock, at('2026-03-08T10:00:00.000Z'));
    expect(runs).toEqual([]);
    expect(missed.map((event) => event.reason)).toEqual(['dst-gap']);
    expect(isoOf(await fieldOf(engine, 'daily', 'skipUntil'))).toBe('2026-03-09T09:30:00.000Z');

    await tickEngine(engine, clock, at('2026-03-09T09:30:00.000Z'));
    expect(runs).toEqual([]);
    expect(await fieldOf(engine, 'daily', 'skipUntil')).toBeUndefined();

    await tickEngine(engine, clock, at('2026-03-10T09:30:00.000Z'));
    expect(runs).toEqual(['2026-03-10T09:30:00.000Z']);
  });

  it('changes nothing when the next fire is already skipped', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    await engine.skipNextScheduleOccurrence('daily');
    clock.now += 60_000;
    await engine.skipNextScheduleOccurrence('daily');

    const summary = await summaryOf(engine, 'daily');
    // The second skip wrote nothing: the record is as the first one left it.
    expect(isoOf(summary.updatedAt)).toBe('2026-01-01T00:00:00.000Z');
    expect(isoOf(summary.skipUntil)).toBe('2026-01-01T09:00:00.000Z');
  });

  it('refuses a skip naming an occurrence a fire has passed, writing nothing', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    const occurrence = await fieldOf(engine, 'daily', 'nextFireAt');
    await tickEngine(engine, clock, at('2026-01-01T09:00:00.000Z'));
    expect(runs).toEqual(['2026-01-01T09:00:00.000Z']);
    const before = await summaryOf(engine, 'daily');

    const failure = await engine
      .skipNextScheduleOccurrence('daily', { occurrence: occurrence! })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ScheduleOccurrenceNotNextError);
    expect((failure as ScheduleOccurrenceNotNextError).occurrence).toBe(occurrence!);
    expect((failure as ScheduleOccurrenceNotNextError).nextOccurrence).toBe(
      at('2026-01-02T09:00:00.000Z'),
    );
    const after = await summaryOf(engine, 'daily');
    expect(after.skipUntil).toBeUndefined();
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('skips the occurrence it names when that is the next real one', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    const occurrence = (await fieldOf(engine, 'daily', 'nextFireAt'))!;

    await engine.skipNextScheduleOccurrence('daily', { occurrence });
    await tickEngine(engine, clock, occurrence);
    await tickEngine(engine, clock, occurrence + 24 * 60 * 60_000);

    expect(runs).toEqual(['2026-01-02T09:00:00.000Z']);
  });

  it('refuses an occurrence that is later than the next one', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    const failure = await engine
      .skipNextScheduleOccurrence('daily', { occurrence: at('2026-01-02T09:00:00.000Z') })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ScheduleOccurrenceNotNextError);
    expect(await fieldOf(engine, 'daily', 'skipUntil')).toBeUndefined();
  });

  it('refuses nextFireAt when it is the end of a gap that fires nothing, and accepts the real run', async () => {
    opened = open('2026-03-07T11:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '30 2 * * *', { id: 'daily', timeZone: LOS_ANGELES });
    const gapEnd = (await fieldOf(engine, 'daily', 'nextFireAt'))!;
    expect(isoOf(gapEnd)).toBe('2026-03-08T10:00:00.000Z');

    const failure = await engine.skipNextScheduleOccurrence('daily', { occurrence: gapEnd }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ScheduleOccurrenceNotNextError);
    expect(await fieldOf(engine, 'daily', 'skipUntil')).toBeUndefined();

    await engine.skipNextScheduleOccurrence('daily', {
      occurrence: at('2026-03-09T09:30:00.000Z'),
    });
    expect(isoOf(await fieldOf(engine, 'daily', 'skipUntil'))).toBe('2026-03-09T09:30:00.000Z');
  });

  it('refuses an overdue nextFireAt that a late tick counts missed, and names the one after now', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    const overdue = (await fieldOf(engine, 'daily', 'nextFireAt'))!;
    clock.now = at('2026-01-03T12:00:00.000Z');

    const failure = await engine.skipNextScheduleOccurrence('daily', { occurrence: overdue }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ScheduleOccurrenceNotNextError);

    await engine.skipNextScheduleOccurrence('daily', {
      occurrence: at('2026-01-04T09:00:00.000Z'),
    });
    expect(isoOf(await fieldOf(engine, 'daily', 'skipUntil'))).toBe('2026-01-04T09:00:00.000Z');
  });

  it('changes nothing when it names the occurrence already skipped, and refuses the run after it', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    const first = at('2026-01-01T09:00:00.000Z');
    await engine.skipNextScheduleOccurrence('daily', { occurrence: first });
    clock.now += 60_000;

    await engine.skipNextScheduleOccurrence('daily', { occurrence: first });
    const failure = await engine
      .skipNextScheduleOccurrence('daily', { occurrence: first + 24 * 60 * 60_000 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ScheduleOccurrenceNotNextError);
    const summary = await summaryOf(engine, 'daily');
    expect(isoOf(summary.updatedAt)).toBe('2026-01-01T00:00:00.000Z');
    expect(summary.skipUntil).toBe(first);
  });

  it('checks expectedRevision before the occurrence', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    const failure = await engine
      .skipNextScheduleOccurrence('daily', {
        expectedRevision: 7,
        occurrence: at('2026-01-05T09:00:00.000Z'),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect((failure as Error).name).toBe('ScheduleStaleRevisionError');
  });

  it('rejects an occurrence that is not a non-negative integer', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    for (const occurrence of [-1, 1.5, Number.NaN, '1' as unknown as number]) {
      const failure = await engine.skipNextScheduleOccurrence('daily', { occurrence }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((failure as Error).message).toContain('options.occurrence must be');
    }
    expect(await fieldOf(engine, 'daily', 'skipUntil')).toBeUndefined();
  });

  it('is refused for a stale expectedRevision, writing nothing', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });

    const failure = await engine.skipNextScheduleOccurrence('daily', { expectedRevision: 7 }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('ScheduleStaleRevisionError');
    expect(await fieldOf(engine, 'daily', 'skipUntil')).toBeUndefined();
  });

  it('is refused for a schedule that is paused, cancelled, or missing', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'paused' });
    await engine.pauseSchedule('paused');
    await engine.schedule('report', null, '0 9 * * *', { id: 'gone' });
    await engine.cancelSchedule('gone');

    for (const [id, expected] of [
      ['paused', 'paused and has no next occurrence'],
      ['gone', 'cancelled and has no next occurrence'],
      ['nope', 'not found'],
    ] as const) {
      const failure = await engine.skipNextScheduleOccurrence(id).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((failure as Error).message).toContain(expected);
    }
  });

  it('ends when the schedule is paused or its cadence changes', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'paused' });
    await engine.schedule('report', null, '0 9 * * *', { id: 'updated' });
    await engine.skipNextScheduleOccurrence('paused');
    await engine.skipNextScheduleOccurrence('updated');

    await engine.pauseSchedule('paused');
    await engine.updateSchedule('updated', '0 10 * * *');

    expect(await fieldOf(engine, 'paused', 'skipUntil')).toBeUndefined();
    expect(await fieldOf(engine, 'updated', 'skipUntil')).toBeUndefined();
  });

  it('survives an update that leaves the next run where it was', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily' });
    await engine.schedule('report', null, '0 9 * * *', { id: 'weekdays' });
    await engine.skipNextScheduleOccurrence('daily');
    await engine.skipNextScheduleOccurrence('weekdays');

    // Only a description and a policy change; and an expression whose next run is the same one.
    await engine.updateSchedule('daily', '0 9 * * *', { description: 'edited', overlap: 'queue' });
    await engine.updateSchedule('weekdays', '0 9 * * 1-5');

    for (const id of ['daily', 'weekdays']) {
      expect(isoOf(await fieldOf(engine, id, 'skipUntil'))).toBe('2026-01-01T09:00:00.000Z');
      expect(await fieldOf(engine, id, 'revision')).toBe(2);
    }
    await tickEngine(engine, clock, at('2026-01-01T09:00:00.000Z'));
    expect(runs).toEqual([]);
  });

  it('survives an update when the next wake-up is the end of a gap that fires nothing', async () => {
    opened = open('2026-03-07T11:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '30 2 * * *', { id: 'daily', timeZone: LOS_ANGELES });
    await engine.skipNextScheduleOccurrence('daily');

    await engine.updateSchedule('daily', '30 2 * * *', { description: 'edited' });

    expect(isoOf(await fieldOf(engine, 'daily', 'skipUntil'))).toBe('2026-03-09T09:30:00.000Z');
  });

  it('ends when an update moves the next run, or the time zone', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'zone' });
    await engine.skipNextScheduleOccurrence('zone');

    await engine.updateSchedule('zone', '0 9 * * *', { timeZone: LOS_ANGELES });

    expect(await fieldOf(engine, 'zone', 'skipUntil')).toBeUndefined();
  });

  it('ends when an update switches between a cron cadence and an interval', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'switched' });
    await engine.skipNextScheduleOccurrence('switched');

    await engine.updateSchedule('switched', { every: '1h' });

    expect(await fieldOf(engine, 'switched', 'skipUntil')).toBeUndefined();
  });

  it('keeps the anchor and the skip of an interval schedule updated without changing the interval', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs } = opened;
    await engine.schedule('report', null, { every: '1h' }, { id: 'hourly' });
    clock.now = at('2026-01-01T00:20:00.000Z');
    await engine.skipNextScheduleOccurrence('hourly');

    await engine.updateSchedule('hourly', { every: '1h' }, { description: 'edited' });

    const summary = await summaryOf(engine, 'hourly');
    expect(isoOf(summary.nextFireAt)).toBe('2026-01-01T01:00:00.000Z');
    expect(isoOf(summary.skipUntil)).toBe('2026-01-01T01:00:00.000Z');
    expect(isoOf(summary.createdAt)).toBe('2026-01-01T00:00:00.000Z');
    await tickEngine(engine, clock, at('2026-01-01T01:00:00.000Z'));
    await tickEngine(engine, clock, at('2026-01-01T02:00:00.000Z'));
    expect(runs).toEqual(['2026-01-01T02:00:00.000Z']);
  });

  it('re-anchors an interval schedule whose interval changes, and ends the skip', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock } = opened;
    await engine.schedule('report', null, { every: '1h' }, { id: 'hourly' });
    clock.now = at('2026-01-01T00:20:00.000Z');
    await engine.skipNextScheduleOccurrence('hourly');

    await engine.updateSchedule('hourly', { every: '2h' });

    const summary = await summaryOf(engine, 'hourly');
    expect(isoOf(summary.nextFireAt)).toBe('2026-01-01T02:20:00.000Z');
    expect(summary.skipUntil).toBeUndefined();
  });

  it('does not queue the skipped occurrence behind a running one', async () => {
    opened = open('2026-01-01T00:00:00.000Z', { hold: true });
    const { engine, clock } = opened;
    await engine.schedule('report', null, { every: '1h' }, { id: 'queued', overlap: 'queue' });
    await tickEngine(engine, clock, at('2026-01-01T01:00:00.000Z'));
    await engine.skipNextScheduleOccurrence('queued');

    await tickEngine(engine, clock, at('2026-01-01T02:00:00.000Z'));

    expect(await fieldOf(engine, 'queued', 'queuedRuns')).toEqual([]);
    await releaseRunningWorkflows(engine);
  });
});

describe('running a schedule now', () => {
  let opened: Opened | undefined;

  afterEach(() => {
    opened?.engine[Symbol.dispose]();
    opened = undefined;
  });

  it('starts one run, marked manual, and leaves the cadence alone', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, clock, runs, resolved } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily', overlap: 'allow' });
    const before = await summaryOf(engine, 'daily');
    clock.now = at('2026-01-01T03:00:00.000Z');

    const result = await engine.triggerSchedule('daily');
    await drainEngine();

    expect(result.outcome).toBe('started');
    expect(runs).toEqual(['2026-01-01T03:00:00.000Z']);
    expect(resolved).toEqual([{ id: 'daily', manual: true }]);
    const after = await summaryOf(engine, 'daily');
    expect(after.nextFireAt).toBe(before.nextFireAt);
    expect(after.lastFireAt).toBeUndefined();
    expect(after.revision).toBe(before.revision);
    if (result.outcome === 'started') {
      expect(await engine.getScheduleProvenance(result.workflowId)).toEqual({
        scheduleId: 'daily',
        manual: true,
      });
    }

    // The cadence goes on as if nothing had happened.
    await tickEngine(engine, clock, at('2026-01-01T09:00:00.000Z'));
    expect(runs).toEqual(['2026-01-01T03:00:00.000Z', '2026-01-01T09:00:00.000Z']);
    expect(resolved.at(-1)).toEqual({ id: 'daily', occurrence: at('2026-01-01T09:00:00.000Z') });
  });

  it('reports skipped while a run is going and the policy is skip', async () => {
    opened = open('2026-01-01T00:00:00.000Z', { hold: true });
    const { engine, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily', overlap: 'skip' });

    const first = await engine.triggerSchedule('daily');
    await drainEngine();
    const second = await engine.triggerSchedule('daily');

    expect(first.outcome).toBe('started');
    expect(second).toEqual({
      outcome: 'skipped',
      blockingWorkflowId: first.outcome === 'started' ? first.workflowId : '',
    });
    expect(runs).toHaveLength(1);
    const summary = await summaryOf(engine, 'daily');
    expect(summary.skippedCount).toBe(1);
    expect(summary.currentWorkflowId).toBe(first.outcome === 'started' ? first.workflowId : '');

    await releaseRunningWorkflows(engine);
    const again = await engine.triggerSchedule('daily');
    expect(again.outcome).toBe('started');
    await releaseRunningWorkflows(engine);
  });

  it('queues the run behind the running one under the queue policy, and starts it manual', async () => {
    opened = open('2026-01-01T00:00:00.000Z', { hold: true });
    const { engine, resolved } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily', overlap: 'queue' });
    await engine.triggerSchedule('daily');
    await drainEngine();

    const queued = await engine.triggerSchedule('daily');
    const queuedAgain = await engine.triggerSchedule('daily');

    expect(queued.outcome).toBe('queued');
    expect(queuedAgain.outcome).toBe('queued');
    const queuedIds = [queued, queuedAgain].map((result) =>
      result.outcome === 'queued' ? result.workflowId : '',
    );
    expect(new Set(queuedIds).size).toBe(2);
    expect(await fieldOf(engine, 'daily', 'queuedRuns')).toMatchObject([
      { workflowId: queuedIds[0], manual: true },
      { workflowId: queuedIds[1], manual: true },
    ]);
    await releaseRunningWorkflows(engine);
    await releaseRunningWorkflows(engine);
    await releaseRunningWorkflows(engine);
    expect(await fieldOf(engine, 'daily', 'queuedRuns')).toEqual([]);
    expect(resolved).toEqual([
      { id: 'daily', manual: true },
      { id: 'daily', manual: true },
      { id: 'daily', manual: true },
    ]);
  });

  it('runs a paused schedule, and refuses a cancelled or missing one', async () => {
    opened = open('2026-01-01T00:00:00.000Z');
    const { engine, runs } = opened;
    await engine.schedule('report', null, '0 9 * * *', { id: 'paused' });
    await engine.pauseSchedule('paused');
    await engine.schedule('report', null, '0 9 * * *', { id: 'gone' });
    await engine.cancelSchedule('gone');

    const ran = await engine.triggerSchedule('paused');
    expect(ran.outcome).toBe('started');
    await drainEngine();
    expect(runs).toHaveLength(1);
    expect(await fieldOf(engine, 'paused', 'status')).toBe('paused');
    for (const [id, expected] of [
      ['gone', 'cancelled and cannot be run'],
      ['nope', 'not found'],
    ] as const) {
      const failure = await engine.triggerSchedule(id).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((failure as Error).message).toContain(expected);
    }
  });
});

describe('a persisted schedule record and its skip', () => {
  let opened: Opened | undefined;

  afterEach(() => {
    opened?.engine[Symbol.dispose]();
    opened = undefined;
  });

  async function persistedRecord(): Promise<Record<string, unknown>> {
    opened = open('2026-01-01T00:00:00.000Z');
    await opened.engine.schedule('report', null, '0 9 * * *', { id: 'stored' });
    await opened.engine.skipNextScheduleOccurrence('stored');
    const bytes = await opened.engine.storage.get(KEYS.schedule('stored'));
    return decode(bytes!) as Record<string, unknown>;
  }

  it('reads a record written before schedules could be skipped as not skipped', async () => {
    const { skipUntil: _dropped, ...legacy } = await persistedRecord();
    const state = decodeScheduleState(encode(legacy));
    expect(state).not.toBeNull();
    expect(state?.skipUntil).toBeUndefined();
    expect(state && 'skipUntil' in state).toBe(false);
  });

  it('keeps the skip it was written with', async () => {
    expect(decodeScheduleState(encode(await persistedRecord()))?.skipUntil).toBe(
      at('2026-01-01T09:00:00.000Z'),
    );
  });

  it('rejects a record whose skip is not a timestamp', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const record = await persistedRecord();
      expect(decodeScheduleState(encode({ ...record, skipUntil: 'soon' }))).toBeNull();
      expect(decodeScheduleState(encode({ ...record, skipUntil: -1 }))).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        '[weft] Ignoring malformed schedule "stored" with invalid skipUntil.',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a queued run’s manual mark, and rejects one that is not true', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const record = await persistedRecord();
      const queuedRuns = [{ workflowId: 'w', queuedAt: 1, manual: true as const }];
      expect(decodeScheduleState(encode({ ...record, queuedRuns }))?.queuedRuns).toEqual(
        queuedRuns,
      );
      expect(
        decodeScheduleState(
          encode({ ...record, queuedRuns: [{ workflowId: 'w', queuedAt: 1, manual: false }] }),
        ),
      ).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a schedule control before the workflow catalog is ready', () => {
  it('waits for the catalog, then skips and runs', async () => {
    const clock: Clock = { now: at('2026-01-01T00:00:00.000Z') };
    await using engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => clock.now,
      backgroundTasks: 'manual',
    });
    registerWorkflow(engine, 'report', async function* () {
      return 'done';
    });
    await engine.schedule('report', null, '0 9 * * *', { id: 'daily', overlap: 'allow' });

    // A workflow registered after the catalog drained leaves it pending again.
    registerWorkflow(engine, 'later', async function* () {
      return 'done';
    });
    await engine.skipNextScheduleOccurrence('daily');
    registerWorkflow(engine, 'latest', async function* () {
      return 'done';
    });
    const result = await engine.triggerSchedule('daily');

    expect(result.outcome).toBe('started');
    expect(isoOf(await fieldOf(engine, 'daily', 'skipUntil'))).toBe('2026-01-01T09:00:00.000Z');
  });
});
