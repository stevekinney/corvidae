import {
  scheduleDraftOf,
  scheduleSavePlan,
  type ScheduleFormSource,
} from '@lostgradient/interborough-plugin/schedule-form';
import { describe, expect, it } from 'bun:test';

import { runSavePlan, type ToolAnswer, type ToolCall } from './save.ts';

const source: ScheduleFormSource = {
  id: 's1',
  revision: 3,
  status: 'active',
  description: 'Morning',
  cronExpression: '0 9 * * *',
  intervalMs: null,
  timeZone: 'UTC',
  target: { kind: 'agent', agentName: 'writer' },
};

const view = {
  ...source,
  id: 'made',
  revision: 1,
  nextFireAt: null,
};

/** A host that answers each call from a script, and records what it was asked. */
function host(answers: Record<string, ToolAnswer | Error>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const call: ToolCall = async (tool, args) => {
    calls.push({ tool, args });
    const answer = answers[tool];
    if (answer === undefined) throw new Error(`unscripted ${tool}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, call };
}

const fault = (message: string, data?: unknown): ToolAnswer => ({
  isError: true,
  content: [{ type: 'text', text: message }],
  ...(data === undefined ? {} : { structuredContent: data }),
});

describe('the calls of one save', () => {
  it('updates, then pauses fenced by the revision the update answered', async () => {
    const plan = scheduleSavePlan(
      { ...scheduleDraftOf(source), spec: '10 9 * * *', paused: true },
      source,
    );
    const { calls, call } = host({
      'bureau.schedules.update': {
        structuredContent: { id: 's1', status: 'active', revision: 4 },
      },
      'bureau.schedules.pause': {
        structuredContent: { id: 's1', status: 'paused', revision: 5 },
      },
    });
    expect(await runSavePlan(plan, source, call)).toEqual({
      kind: 'saved',
      id: 's1',
      done: ['bureau.schedules.update', 'bureau.schedules.pause'],
    });
    expect(calls).toEqual([
      {
        tool: 'bureau.schedules.update',
        args: { spec: '10 9 * * *', scheduleId: 's1', expectedRevision: 3 },
      },
      { tool: 'bureau.schedules.pause', args: { scheduleId: 's1', expectedRevision: 4 } },
    ]);
  });

  it('makes a schedule, then pauses the one it made, naming it and its revision', async () => {
    const plan = scheduleSavePlan({
      ...scheduleDraftOf(source),
      description: '',
      target: 'writer',
      input: 'Hi',
      paused: true,
    });
    const { calls, call } = host({
      'bureau.schedules.create': { structuredContent: view },
      'bureau.schedules.pause': {
        structuredContent: { id: 'made', status: 'paused', revision: 2 },
      },
    });
    const outcome = await runSavePlan(plan, undefined, call);
    expect(outcome).toMatchObject({ kind: 'saved', id: 'made' });
    expect(calls[0]?.args).not.toHaveProperty('scheduleId');
    expect(calls[1]).toEqual({
      tool: 'bureau.schedules.pause',
      args: { scheduleId: 'made', expectedRevision: 1 },
    });
  });

  it('stops at a refused first call, writing nothing, and carries the fault', async () => {
    const plan = scheduleSavePlan(
      { ...scheduleDraftOf(source), spec: 'oops', paused: true },
      source,
    );
    const { calls, call } = host({
      'bureau.schedules.update': fault('Not a cron expression', {
        issues: [{ path: ['spec'], message: 'Not a cron expression' }],
      }),
    });
    const outcome = await runSavePlan(plan, source, call);
    expect(outcome).toEqual({
      kind: 'refused',
      id: 's1',
      done: [],
      fault: {
        message: 'Not a cron expression',
        fields: { spec: 'Not a cron expression' },
        currentRevision: undefined,
      },
    });
    // The pause is never tried after an update that was refused.
    expect(calls.map((entry) => entry.tool)).toEqual(['bureau.schedules.update']);
  });

  it('says which part was written when the second call is refused', async () => {
    const plan = scheduleSavePlan(
      { ...scheduleDraftOf(source), spec: '0 8 * * *', paused: true },
      source,
    );
    const { call } = host({
      'bureau.schedules.update': { structuredContent: { id: 's1', status: 'active', revision: 4 } },
      'bureau.schedules.pause': fault('Stale', { currentRevision: 6 }),
    });
    const outcome = await runSavePlan(plan, source, call);
    expect(outcome).toMatchObject({
      kind: 'refused',
      id: 's1',
      done: ['bureau.schedules.update'],
      fault: { currentRevision: 6 },
    });
  });

  it('keeps the schedule it made when the pause after a create is refused', async () => {
    const plan = scheduleSavePlan({
      ...scheduleDraftOf(source),
      target: 'writer',
      input: 'Hi',
      paused: true,
    });
    const { call } = host({
      'bureau.schedules.create': { structuredContent: view },
      'bureau.schedules.pause': fault('Nope'),
    });
    expect(await runSavePlan(plan, undefined, call)).toMatchObject({
      kind: 'refused',
      id: 'made',
      done: ['bureau.schedules.create'],
    });
  });

  it('does not guess at an answer it cannot read', async () => {
    const plan = scheduleSavePlan({ ...scheduleDraftOf(source), spec: '0 8 * * *' }, source);
    const { call } = host({ 'bureau.schedules.update': { structuredContent: { odd: true } } });
    expect(await runSavePlan(plan, source, call)).toEqual({
      kind: 'unreadable',
      id: 's1',
      done: [],
      tool: 'bureau.schedules.update',
    });
  });

  it('says the host did not answer, and what had been written before, without retrying', async () => {
    const plan = scheduleSavePlan(
      { ...scheduleDraftOf(source), spec: '0 8 * * *', paused: true },
      source,
    );
    const { calls, call } = host({
      'bureau.schedules.update': { structuredContent: { id: 's1', status: 'active', revision: 4 } },
      'bureau.schedules.pause': new Error('connection lost'),
    });
    expect(await runSavePlan(plan, source, call)).toEqual({
      kind: 'unanswered',
      id: 's1',
      done: ['bureau.schedules.update'],
      tool: 'bureau.schedules.pause',
    });
    expect(calls).toHaveLength(2);
    // A create whose answer was lost names no schedule, so the page can read none back.
    const created = host({ 'bureau.schedules.create': new Error('connection lost') });
    expect(
      await runSavePlan(
        scheduleSavePlan({ ...scheduleDraftOf(source), target: 'writer', input: 'Hi' }),
        undefined,
        created.call,
      ),
    ).toEqual({ kind: 'unanswered', id: undefined, done: [], tool: 'bureau.schedules.create' });
  });

  it('makes no call for a plan with none', async () => {
    const { calls, call } = host({});
    expect(await runSavePlan([], source, call)).toEqual({ kind: 'saved', id: 's1', done: [] });
    expect(calls).toEqual([]);
  });
});
