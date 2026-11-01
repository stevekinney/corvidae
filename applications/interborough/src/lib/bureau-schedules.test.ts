import { afterEach, describe, expect, test } from 'bun:test';

import {
  bureauSpecOf,
  createAgentSchedule,
  listAgentScheduleMissed,
  listBureauSchedules,
  pauseAgentSchedule,
  runNowAgentSchedule,
  skipNextAgentSchedule,
  updateAgentSchedule,
} from './bureau-schedules.ts';
import { installBureauStub, type BureauStub } from './bureau-stub.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

const VIEW = {
  id: 's-1',
  owner: 'anonymous:local',
  agentName: 'assistant',
  inputPreview: 'Summarize what happened yesterday.',
  workflowType: 'agentRun',
  description: null,
  cronExpression: '0 9 * * *',
  intervalMs: null,
  status: 'active',
  overlap: 'skip',
  revision: 1,
  timeZone: 'UTC',
  nextFireAt: null,
  skipUntil: null,
  lastFireAt: null,
  missedFireCount: 0,
  skippedCount: 0,
  createdAt: '2026-10-19T08:00:00.000Z',
  updatedAt: '2026-10-19T08:00:00.000Z',
};

describe('the cadence the Bureau is sent', () => {
  test('is a cron expression as written', () => {
    expect(bureauSpecOf({ cron: '*/15 * * * *' })).toBe('*/15 * * * *');
  });

  test('is an interval in the largest unit that holds it whole, in Weft’s duration grammar', () => {
    expect(bureauSpecOf({ every: 15 * 60_000 })).toBe('15m');
    expect(bureauSpecOf({ every: 3_600_000 })).toBe('1h');
    expect(bureauSpecOf({ every: 36 * 3_600_000 })).toBe('36h');
    expect(bureauSpecOf({ every: 7 * 86_400_000 })).toBe('7d');
    expect(bureauSpecOf({ every: 90_000 })).toBe('90s');
    expect(bureauSpecOf({ every: 1_500 })).toBe('1500ms');
    expect(bureauSpecOf({ every: '6h' })).toBe('6h');
  });
});

describe('the Bureau’s schedules', () => {
  test('are listed across pages, to the end', async () => {
    stub = installBureauStub({
      'bureau.schedules.list': (params) =>
        params['offset'] === 0
          ? { schedules: [VIEW], nextOffset: 1 }
          : { schedules: [{ ...VIEW, id: 's-2' }], nextOffset: null },
    });
    const listed = await listBureauSchedules();
    expect(listed.map((schedule) => schedule.id)).toEqual(['s-1', 's-2']);
    expect(stub.callsTo('bureau.schedules.list').map((call) => call.params['offset'])).toEqual([
      0, 1,
    ]);
  });

  test('are created without an input a field left empty, and the agent comes back named', async () => {
    stub = installBureauStub({ 'bureau.schedules.create': () => VIEW });

    const created = await createAgentSchedule({
      agentName: 'assistant',
      spec: '1h',
      input: 'Hello',
      description: '',
      sessionId: '',
      overlap: 'skip',
    });

    expect(created.agentName).toBe('assistant');
    expect(created.inputPreview).toBe('Summarize what happened yesterday.');
    expect(stub.callsTo('bureau.schedules.create')[0]?.params).toEqual({
      agentName: 'assistant',
      spec: '1h',
      input: 'Hello',
      overlap: 'skip',
    });
  });

  test('name the revision a write read, and send none when there is none to name', async () => {
    stub = installBureauStub({
      'bureau.schedules.pause': () => ({ id: 's-1', status: 'paused', revision: 4 }),
      'bureau.schedules.update': () => ({ id: 's-1', status: 'active', revision: 4 }),
    });

    await pauseAgentSchedule('s-1', 3);
    await pauseAgentSchedule('s-1', undefined);
    await updateAgentSchedule('s-1', { spec: '2h' }, 3);

    expect(stub.callsTo('bureau.schedules.pause').map((call) => call.params)).toEqual([
      { scheduleId: 's-1', expectedRevision: 3 },
      { scheduleId: 's-1' },
    ]);
    expect(stub.callsTo('bureau.schedules.update')[0]?.params).toEqual({
      scheduleId: 's-1',
      spec: '2h',
      expectedRevision: 3,
    });
  });
});

describe('the controls of a Bureau schedule', () => {
  test('skip the next fire naming the revision the caller read, and send none when there is none', async () => {
    stub = installBureauStub({
      'bureau.schedules.skipnext': () => ({ id: 's-1', status: 'active', revision: 3 }),
    });

    await skipNextAgentSchedule('s-1', 3);
    await skipNextAgentSchedule('s-1', undefined);

    expect(stub.callsTo('bureau.schedules.skipnext').map((call) => call.params)).toEqual([
      { scheduleId: 's-1', expectedRevision: 3 },
      { scheduleId: 's-1' },
    ]);
  });

  test('run now answers what the overlap policy did, with the run it started or the one in the way', async () => {
    stub = installBureauStub({
      'bureau.schedules.runnow': (params) =>
        params['scheduleId'] === 'started'
          ? { outcome: 'started', taskId: 'run-1' }
          : params['scheduleId'] === 'queued'
            ? { outcome: 'queued', taskId: 'run-2' }
            : { outcome: 'skipped', blockingTaskId: null },
    });

    expect(await runNowAgentSchedule('started')).toEqual({ outcome: 'started', runId: 'run-1' });
    expect(await runNowAgentSchedule('queued')).toEqual({ outcome: 'queued', runId: 'run-2' });
    expect(await runNowAgentSchedule('busy')).toEqual({ outcome: 'skipped', blockingRunId: null });
  });

  test('list the fires the schedule missed, as the moments they were recorded at', async () => {
    stub = installBureauStub({
      'bureau.schedules.missed': () => ({
        missed: [
          {
            scheduleId: 's-1',
            owner: 'anonymous:local',
            occurrence: '2026-10-19T09:00:00.000Z',
            reason: 'late',
            count: 1,
            recordedAt: '2026-10-19T09:05:00.000Z',
          },
        ],
      }),
    });

    expect(await listAgentScheduleMissed('s-1')).toEqual([
      {
        occurrence: Date.parse('2026-10-19T09:00:00.000Z'),
        reason: 'late',
        count: 1,
        recordedAt: Date.parse('2026-10-19T09:05:00.000Z'),
      },
    ]);
    expect(stub.callsTo('bureau.schedules.missed')[0]?.params).toEqual({ scheduleId: 's-1' });
  });

  test('read the zone and the skipped fire of a schedule', async () => {
    stub = installBureauStub({
      'bureau.schedules.list': () => ({
        schedules: [
          { ...VIEW, timeZone: 'America/Los_Angeles', skipUntil: '2026-10-20T16:00:00.000Z' },
        ],
        nextOffset: null,
      }),
    });

    const [schedule] = await listBureauSchedules();
    expect(schedule?.timeZone).toBe('America/Los_Angeles');
    expect(schedule?.skipUntil).toBe('2026-10-20T16:00:00.000Z');
  });
});
