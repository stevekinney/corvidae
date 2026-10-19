/**
 * COR-1527 — a workflow file with a `schedule` trigger owns exactly one native schedule, and every
 * reconcile puts it back to match the file. Run against a real engine on memory storage.
 */
import {
  Engine,
  MemoryStorage,
  registerWorkflowDocuments,
  type WorkflowDocument,
} from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  parseWorkflowScheduleId,
  reconcileWorkflowSchedules,
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

const hourly: DesiredWorkflowSchedule = { spec: '1h', overlap: 'skip', paused: false };

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

describe('workflow schedule ids', () => {
  it('round-trips an identifier and a generation, and ignores every other id', () => {
    const id = workflowScheduleId('nightly-digest', 3);
    expect(id).toBe('bureau-workflow-schedule:nightly-digest:3');
    expect(parseWorkflowScheduleId(id)).toEqual({ identifier: 'nightly-digest', generation: 3 });
    expect(parseWorkflowScheduleId('schedule-abc')).toBeUndefined();
    expect(parseWorkflowScheduleId('bureau-workflow-schedule:nightly-digest')).toBeUndefined();
    expect(parseWorkflowScheduleId('bureau-workflow-schedule:a:b:1')).toBeUndefined();
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
      new Map([['digest', { spec: '*/5 * * * *', overlap: 'queue', paused: false }]]),
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
    expect(second).toEqual({ created: [], updated: [], paused: [], resumed: [], cancelled: [] });
    expect(await live(engine)).toHaveLength(1);
    expect(await everySchedule(engine)).toHaveLength(1);
  });

  it('updates a changed spec or overlap in place', async () => {
    await using engine = await engineWith('digest');
    await reconcileWorkflowSchedules(engine, new Map([['digest', hourly]]));
    const result = await reconcileWorkflowSchedules(
      engine,
      new Map([['digest', { spec: '30m', overlap: 'allow', paused: false }]]),
    );
    expect(result.updated).toEqual(['bureau-workflow-schedule:digest:1']);
    const [schedule] = await live(engine);
    expect(schedule).toMatchObject({ intervalMs: 30 * 60_000, overlap: 'allow' });
    expect(await live(engine)).toHaveLength(1);
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
    await engine.schedule('digest', null, { every: '1h' }, { id: workflowScheduleId('digest', 1) });
    await engine.schedule('digest', null, { every: '1h' }, { id: workflowScheduleId('digest', 2) });
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
