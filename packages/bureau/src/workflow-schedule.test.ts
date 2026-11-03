/**
 * COR-1527 — a workflow file with a `schedule` trigger owns exactly one native schedule, and every
 * reconcile puts it back to match the file. Run against a real engine on memory storage.
 */
import {
  decode,
  Engine,
  KEYS,
  registerWorkflowDocuments,
  type WorkflowDocument,
} from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import {
  parseWorkflowScheduleId,
  reconcileWorkflowSchedules,
  scheduleTrigger,
  workflowScheduleId,
  type DesiredWorkflowSchedule,
} from './workflow-schedule';
import { createWorkflowDocumentHost } from './workflow-host';

const host = createWorkflowDocumentHost({
  runAgentStep: async () => ({ content: '', output: null, finishReason: 'stop-condition' }),
});

function document(name: string): WorkflowDocument {
  return {
    name,
    trigger: { kind: 'schedule', spec: '1h' },
    steps: [{ kind: 'sleep', duration: 1 }],
  };
}

const hourly: DesiredWorkflowSchedule = {
  spec: '1h',
  overlap: 'skip',
  timeZone: 'UTC',
  backfill: false,
  paused: false,
};

async function engineWith(...names: string[]): Promise<Engine> {
  const engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
  await registerWorkflowDocuments(engine, host, { active: names.map(document) });
  return engine;
}

async function live(engine: Engine) {
  const page = await engine.listSchedules({ status: ['active', 'paused'] });
  return page.items;
}

async function liveIds(engine: Engine): Promise<string[]> {
  const schedules = await live(engine);
  return schedules.map((schedule) => schedule.id);
}

async function liveTypes(engine: Engine): Promise<string[]> {
  const schedules = await live(engine);
  return schedules.map((schedule) => schedule.workflowType);
}

async function firstLiveStatus(engine: Engine): Promise<string | undefined> {
  const schedules = await live(engine);
  return schedules[0]?.status;
}

async function statusOf(engine: Engine, id: string): Promise<string | undefined> {
  const summary = await engine.getSchedule(id);
  return summary?.status;
}

async function everySchedule(engine: Engine) {
  const page = await engine.listSchedules({});
  return page.items;
}

/** The input schedule `id` starts each fire with, which Weft's summary leaves out. */
async function inputOf(engine: Engine, id: string): Promise<unknown> {
  const bytes = await engine.storage.get(KEYS.schedule(id));
  return bytes === null || bytes === undefined
    ? undefined
    : (decode(bytes) as { input?: unknown }).input;
}

describe('workflow schedule ids', () => {
  it('round-trips an identifier and a generation, and ignores every other id', () => {
    const id = workflowScheduleId('nightly-digest', 3);
    expect(id).toBe('bureau-workflow-schedule:nightly-digest:3');
    expect(parseWorkflowScheduleId(id)).toEqual({ identifier: 'nightly-digest', generation: 3 });
    expect(parseWorkflowScheduleId('schedule-abc')).toBeUndefined();
    expect(parseWorkflowScheduleId('bureau-workflow-schedule:nightly-digest')).toBeUndefined();
    expect(parseWorkflowScheduleId('bureau-workflow-schedule:a:b:c:1')).toBeUndefined();
    expect(parseWorkflowScheduleId('bureau-workflow-schedule:Digest:1')).toBeUndefined();
    // A plugin's workflow (COR-1956) keeps its colon: the generation follows the last one.
    expect(parseWorkflowScheduleId(workflowScheduleId('linear:sync', 2))).toEqual({
      identifier: 'linear:sync',
      generation: 2,
    });
  });

  it('is an id Weft accepts, listed and found like any other', async () => {
    await using engine = await engineWith('digest');
    await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    const [schedule] = await live(engine);
    expect(schedule?.id).toBe('bureau-workflow-schedule:digest:1');
    expect(await engine.getSchedule('bureau-workflow-schedule:digest:1')).not.toBeNull();
  });
});

describe('reconciling workflow schedules', () => {
  it('creates a missing schedule for the workflow, with the cadence and overlap the file says', async () => {
    await using engine = await engineWith('digest');
    const result = await reconcileWorkflowSchedules(
      engine,
      new Map([
        [
          'digest',
          {
            spec: '*/5 * * * *',
            overlap: 'queue',
            timeZone: 'UTC',
            backfill: false,
            paused: false,
          },
        ],
      ]),
    );
    expect(result.created).toEqual(['bureau-workflow-schedule:digest:1']);
    const [schedule] = await live(engine);
    expect(schedule).toMatchObject({
      workflowType: 'digest',
      cronExpression: '*/5 * * * *',
      overlap: 'queue',
      status: 'active',
      revisionPolicy: 'active-at-fire',
    });
  });

  it('changes nothing the second time, so two restarts in a row leave one live schedule', async () => {
    await using engine = await engineWith('digest');
    const desired = new Map([['digest', hourly]]);
    await reconcileWorkflowSchedules(engine, desired);
    const second = await reconcileWorkflowSchedules(engine, desired);
    await reconcileWorkflowSchedules(engine, desired);
    expect(second).toEqual({
      created: [],
      updated: [],
      paused: [],
      resumed: [],
      cancelled: [],
      held: [],
    });
    expect(await live(engine)).toHaveLength(1);
    expect(await everySchedule(engine)).toHaveLength(1);
  });

  it('updates a changed spec or overlap in place', async () => {
    await using engine = await engineWith('digest');
    await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    const result = await reconcileWorkflowSchedules(
      engine,
      new Map([
        [
          'digest',
          { spec: '30m', overlap: 'allow', timeZone: 'UTC', backfill: false, paused: false },
        ],
      ]),
    );
    expect(result.updated).toEqual(['bureau-workflow-schedule:digest:1']);
    const [schedule] = await live(engine);
    expect(schedule).toMatchObject({ intervalMs: 30 * 60_000, overlap: 'allow' });
    expect(await live(engine)).toHaveLength(1);
  });

  it("creates a cron schedule in the trigger's time zone, catching up only when asked (COR-2009)", async () => {
    await using engine = await engineWith('digest');
    await reconcileWorkflowSchedules(
      engine,
      new Map([
        [
          'digest',
          {
            spec: '0 11 * * 5',
            overlap: 'skip',
            timeZone: 'America/Chicago',
            backfill: false,
            paused: false,
          },
        ],
      ]),
    );
    const [schedule] = await live(engine);
    expect(schedule).toMatchObject({
      cronExpression: '0 11 * * 5',
      timeZone: 'America/Chicago',
      backfill: false,
    });
  });

  it('updates a changed time zone or catch-up in place, and changes nothing once they match', async () => {
    await using engine = await engineWith('digest');
    const cron = { spec: '0 9 * * 1-5', overlap: 'skip', paused: false } as const;
    await reconcileWorkflowSchedules(
      engine,
      new Map([['digest', { ...cron, timeZone: 'UTC', backfill: false }]]),
    );
    const changed = new Map([['digest', { ...cron, timeZone: 'America/Chicago', backfill: true }]]);
    const result = await reconcileWorkflowSchedules(engine, changed);
    expect(result.updated).toEqual(['bureau-workflow-schedule:digest:1']);
    const [schedule] = await live(engine);
    expect(schedule).toMatchObject({ timeZone: 'America/Chicago', backfill: true });
    const again = await reconcileWorkflowSchedules(engine, changed);
    expect(again.updated).toEqual([]);
  });

  it('gives an interval schedule no time zone, so a UTC default never refuses it', async () => {
    await using engine = await engineWith('digest');
    await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    const again = await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    expect(again.updated).toEqual([]);
    const [schedule] = await live(engine);
    expect(schedule).toMatchObject({ intervalMs: 3_600_000, backfill: false });
  });

  it('pauses when the file says paused and resumes when it does not', async () => {
    await using engine = await engineWith('digest');
    await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    const paused = await reconcileWorkflowSchedules(
      engine,
      new Map([['digest', { ...hourly, paused: true }]]),
    );
    expect(paused.paused).toEqual(['bureau-workflow-schedule:digest:1']);
    expect(await firstLiveStatus(engine)).toBe('paused');
    const resumed = await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    expect(resumed.resumed).toEqual(['bureau-workflow-schedule:digest:1']);
    expect(await firstLiveStatus(engine)).toBe('active');
  });

  it('creates a schedule that is paused from the start when the file is paused', async () => {
    await using engine = await engineWith('digest');
    await reconcileWorkflowSchedules(engine, new Map([['digest', { ...hourly, paused: true }]]));
    expect(await firstLiveStatus(engine)).toBe('paused');
  });

  it('cancels the schedule when the file is deleted or becomes invalid, and the engine reports it cancelled', async () => {
    await using engine = await engineWith('digest');
    await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    const result = await reconcileWorkflowSchedules(engine, new Map());
    expect(result.cancelled).toEqual(['bureau-workflow-schedule:digest:1']);
    expect(await statusOf(engine, 'bureau-workflow-schedule:digest:1')).toBe('cancelled');
    expect(await live(engine)).toEqual([]);
  });

  it('schedules again under the next generation after a delete and a create', async () => {
    await using engine = await engineWith('digest');
    await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    await reconcileWorkflowSchedules(engine, new Map());
    const again = await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    expect(again.created).toEqual(['bureau-workflow-schedule:digest:2']);
    expect(await liveIds(engine)).toEqual(['bureau-workflow-schedule:digest:2']);
    // The first generation stays, cancelled.
    expect(await statusOf(engine, 'bureau-workflow-schedule:digest:1')).toBe('cancelled');
  });

  it('schedules again after a file becomes invalid and is fixed', async () => {
    await using engine = await engineWith('digest');
    await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    await reconcileWorkflowSchedules(engine, new Map());
    await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    await reconcileWorkflowSchedules(engine, new Map());
    const fixed = await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    expect(fixed.created).toEqual(['bureau-workflow-schedule:digest:3']);
  });

  it('cancels all but the newest live schedule of a workflow', async () => {
    await using engine = await engineWith('digest');
    for (const generation of [1, 2]) {
      const id = workflowScheduleId('digest', generation);
      await engine.schedule('digest', scheduleTrigger(id), { every: '1h' }, { id });
    }
    const result = await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    expect(result.cancelled).toEqual([workflowScheduleId('digest', 1)]);
    expect(await liveIds(engine)).toEqual([workflowScheduleId('digest', 2)]);
  });

  it('leaves schedules that are not Bureau workflow schedules alone', async () => {
    await using engine = await engineWith('digest');
    await engine.schedule('digest', null, { every: '1h' }, { id: 'someone-elses' });
    await reconcileWorkflowSchedules(engine, new Map());
    expect(await statusOf(engine, 'someone-elses')).toBe('active');
  });

  it("describes the schedule by the trigger's name, or by the workflow when it has none, and renames it in place (COR-2009)", async () => {
    await using engine = await engineWith('digest');
    await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    const [unnamed] = await live(engine);
    expect(unnamed?.description).toBe('Workflow digest');
    const named = new Map([['digest', { ...hourly, description: 'Release notes digest' }]]);
    const renamed = await reconcileWorkflowSchedules(engine, named);
    expect(renamed.updated).toEqual(['bureau-workflow-schedule:digest:1']);
    expect(renamed.created).toEqual([]);
    const [renamedSchedule] = await live(engine);
    expect(renamedSchedule?.description).toBe('Release notes digest');
    const again = await reconcileWorkflowSchedules(engine, named);
    expect(again).toEqual({
      created: [],
      updated: [],
      paused: [],
      resumed: [],
      cancelled: [],
      held: [],
    });
  });

  it("starts every fire with the trigger's input beside the schedule id, and with none when it gives none (COR-2009)", async () => {
    await using engine = await engineWith('digest', 'plain');
    await reconcileWorkflowSchedules(
      engine,
      new Map([
        ['digest', { ...hourly, input: { branch: 'main' } }],
        ['plain', hourly],
      ]),
    );
    const digest = workflowScheduleId('digest', 1);
    const plain = workflowScheduleId('plain', 1);
    expect(await inputOf(engine, digest)).toEqual({
      kind: 'schedule',
      scheduleId: digest,
      input: { branch: 'main' },
    });
    expect(await inputOf(engine, plain)).toEqual({ kind: 'schedule', scheduleId: plain });
  });

  it('changes nothing for the same input, whatever order its keys are written in', async () => {
    await using engine = await engineWith('digest');
    const input = { branch: 'main', since: '2026-10-01' };
    await reconcileWorkflowSchedules(engine, new Map([['digest', { ...hourly, input }]]));
    const reordered = { since: '2026-10-01', branch: 'main' };
    const again = await reconcileWorkflowSchedules(
      engine,
      new Map([['digest', { ...hourly, input: reordered }]]),
    );
    expect(again).toEqual({
      created: [],
      updated: [],
      paused: [],
      resumed: [],
      cancelled: [],
      held: [],
    });
    expect(await everySchedule(engine)).toHaveLength(1);
  });

  it('replaces the schedule with the next generation when its input changes, which Weft cannot update (COR-2009)', async () => {
    await using engine = await engineWith('digest');
    await reconcileWorkflowSchedules(
      engine,
      new Map([['digest', { ...hourly, input: { branch: 'main' } }]]),
    );
    const changed = new Map([
      ['digest', { ...hourly, paused: true, input: { branch: 'release' } }],
    ]);
    const result = await reconcileWorkflowSchedules(engine, changed);
    const first = workflowScheduleId('digest', 1);
    const second = workflowScheduleId('digest', 2);
    expect(result).toEqual({
      created: [second],
      updated: [],
      paused: [second],
      resumed: [],
      cancelled: [first],
      held: [],
    });
    expect(await statusOf(engine, first)).toBe('cancelled');
    expect(await liveIds(engine)).toEqual([second]);
    expect(await inputOf(engine, second)).toEqual({
      kind: 'schedule',
      scheduleId: second,
      input: { branch: 'release' },
    });
    // Dropping the input is a change too, and the generation after holds none.
    const dropped = await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    expect(dropped.cancelled).toEqual([second]);
    expect(await inputOf(engine, workflowScheduleId('digest', 3))).toEqual({
      kind: 'schedule',
      scheduleId: workflowScheduleId('digest', 3),
    });
    const settled = await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    expect(settled).toEqual({
      created: [],
      updated: [],
      paused: [],
      resumed: [],
      cancelled: [],
      held: [],
    });
  });

  it('keeps workflows apart', async () => {
    await using engine = await engineWith('one', 'two');
    await reconcileWorkflowSchedules(
      engine,
      new Map([
        ['one', hourly],
        ['two', hourly],
      ]),
    );
    await reconcileWorkflowSchedules(engine, new Map([['two', hourly]]));
    expect(await liveTypes(engine)).toEqual(['two']);
  });
});
