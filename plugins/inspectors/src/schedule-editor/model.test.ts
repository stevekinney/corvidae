import { describe, expect, it } from 'bun:test';

import {
  agentOptionsOf,
  everySchedule,
  faultOfResult,
  isReceipt,
  isScheduleView,
  scheduleLabel,
  scheduleOfTask,
  withCurrent,
  workflowOptionsOf,
  type ScheduleView,
} from './model.ts';

const view: ScheduleView = {
  id: 's1',
  revision: 2,
  status: 'active',
  description: 'Morning summary',
  cronExpression: '0 9 * * *',
  intervalMs: null,
  timeZone: 'UTC',
  nextFireAt: null,
  target: { kind: 'agent', agentName: 'writer' },
};

describe('what the editor reads of the Bureau', () => {
  it('accepts a schedule view with what the form reads, and nothing less', async () => {
    expect(isScheduleView(view)).toBe(true);
    expect(isScheduleView({ ...view, revision: '2' })).toBe(false);
    expect(isScheduleView({ ...view, target: { kind: 'agent' } })).toBe(false);
    expect(isScheduleView({ ...view, target: { kind: 'other', agentName: 'x' } })).toBe(false);
    expect(isScheduleView(null)).toBe(false);
    // A page is read as a list only when every schedule and its `nextOffset` are well formed.
    const listed = (page: unknown) => everySchedule(async () => page);
    expect(await listed({ schedules: [view], nextOffset: null })).toHaveLength(1);
    expect(await listed({ schedules: [{ id: 's' }], nextOffset: null })).toBeUndefined();
    // The guard vouches for `nextOffset` too: a missing or non-integer one is not a list.
    expect(await listed({ schedules: [view] })).toBeUndefined();
    expect(await listed({ schedules: [view], nextOffset: '100' })).toBeUndefined();
    expect(await listed({ schedules: [view], nextOffset: 1.5 })).toBeUndefined();
    expect(isReceipt({ id: 's1', status: 'paused', revision: 3 })).toBe(true);
    expect(isReceipt({ id: 's1', status: 'gone', revision: 3 })).toBe(false);
  });

  it('names the schedule whose fire started a task, and none for a task another thing started', () => {
    expect(
      scheduleOfTask({ id: 't', origin: { kind: 'schedule', scheduleId: 's1', fireId: 'f' } }),
    ).toBe('s1');
    expect(scheduleOfTask({ id: 't', origin: { kind: 'person', principal: 'p' } })).toBeUndefined();
    expect(scheduleOfTask({ id: 't', origin: null })).toBeUndefined();
    expect(scheduleOfTask({ id: 't' })).toBeUndefined();
    expect(scheduleOfTask({ origin: { kind: 'schedule', scheduleId: '' } })).toBeUndefined();
    expect(scheduleOfTask(undefined)).toBeUndefined();
  });

  it('lists agents by name, with the display name when it differs, and leaves out a hidden one', () => {
    expect(
      agentOptionsOf({
        agents: [
          { name: 'writer', displayName: 'Writer' },
          { name: 'editor', displayName: 'editor' },
          { name: 'secret', displayName: 'Secret', visibility: 'hidden' },
        ],
      }),
    ).toEqual([
      { value: 'writer', label: 'Writer (writer)' },
      { value: 'editor', label: 'editor' },
    ]);
    expect(agentOptionsOf({ agents: [{ displayName: 'No name' }] })).toBeUndefined();
    expect(agentOptionsOf(undefined)).toBeUndefined();
  });

  it('lists the workflows a schedule can start: code workflows, and ready files that are not paused', () => {
    expect(
      workflowOptionsOf({
        workflows: [
          { id: 'digest', state: 'ready', paused: false, title: 'Digest' },
          { id: 'old', state: 'ready', paused: true, title: null },
          { id: 'broken', state: 'invalid', paused: false, title: null },
          { kind: 'code', id: 'kit:echo', title: 'Echo' },
        ],
      }),
    ).toEqual([
      { value: 'digest', label: 'Digest (digest)' },
      { value: 'kit:echo', label: 'Echo (kit:echo)' },
    ]);
  });

  it('keeps the schedule’s current target in a picker that does not list it', () => {
    const options = [{ value: 'writer', label: 'Writer' }];
    expect(withCurrent(options, 'writer')).toBe(options);
    expect(withCurrent(options, '')).toBe(options);
    expect(withCurrent(options, 'hidden-agent')).toEqual([
      { value: 'hidden-agent', label: 'hidden-agent' },
      ...options,
    ]);
  });

  it('labels a schedule by its description, when it runs, and its status when it is not active', () => {
    expect(scheduleLabel(view)).toBe('Morning summary, 0 9 * * *');
    expect(
      scheduleLabel({
        ...view,
        description: null,
        cronExpression: null,
        intervalMs: 3_600_000,
        status: 'paused',
        target: { kind: 'workflow', workflowType: 'kit:echo' },
      }),
    ).toBe('kit:echo, 1h (paused)');
  });
});

describe('what a failed call says', () => {
  it('reads the message, the fields the fault names, and the revision a stale write found', () => {
    expect(
      faultOfResult({
        content: [{ type: 'text', text: 'Not a cron expression' }],
        structuredContent: { issues: [{ path: ['spec'], message: 'Not a cron expression' }] },
      }),
    ).toEqual({
      message: 'Not a cron expression',
      fields: { spec: 'Not a cron expression' },
      currentRevision: undefined,
    });
    expect(
      faultOfResult({
        content: [{ type: 'text', text: 'Stale' }],
        structuredContent: { currentRevision: 7 },
      }),
    ).toEqual({ message: 'Stale', fields: {}, currentRevision: 7 });
    expect(faultOfResult({}).message).toBe('The request failed.');
  });

  it('reads every page of schedules, so one past the first hundred can be chosen', async () => {
    const pages = new Map<number, unknown>([
      [0, { schedules: [view], nextOffset: 100 }],
      [100, { schedules: [{ ...view, id: 'later' }], nextOffset: null }],
    ]);
    const offsets: number[] = [];
    const every = await everySchedule(async (offset) => {
      offsets.push(offset);
      return pages.get(offset);
    });
    expect(offsets).toEqual([0, 100]);
    expect(every?.map((schedule) => schedule.id)).toEqual([view.id, 'later']);
  });

  it('stops on a page that does not move forward, and fails on one that is not a list', async () => {
    const stuck = await everySchedule(async () => ({ schedules: [view], nextOffset: 0 }));
    expect(stuck).toHaveLength(1);
    expect(await everySchedule(async () => ({ error: 'no' }))).toBeUndefined();
  });
});
