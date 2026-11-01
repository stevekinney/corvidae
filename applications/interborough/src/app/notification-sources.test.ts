import { afterEach, describe, expect, test } from 'bun:test';

import { installBureauStub, type BureauStub } from '../lib/bureau-stub.test-support.ts';
import { loadChats, loadScheduleNames } from './notification-sources.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

function schedule(id: string, description: string | null, agentName: string | null) {
  return {
    id,
    owner: 'anonymous:local',
    agentName,
    inputPreview: null,
    workflowType: 'agentRun',
    description,
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
}

describe('loadChats', () => {
  test('maps each session to its title, with null for a chat that has none', async () => {
    stub = installBureauStub({
      'bureau.contexts.list': () => ({
        contexts: [
          { id: 'a', title: 'Refund order 1234' },
          { id: 'b', title: null },
        ].map((context) => ({
          ...context,
          owner: null,
          agentName: 'echo',
          lastMessagePreview: null,
          parentContextId: null,
          forkedFromMessageId: null,
          messageCount: 1,
          createdAt: '2026-10-23T09:00:00.000Z',
          updatedAt: '2026-10-23T09:00:00.000Z',
          activity: 'idle',
        })),
        nextOffset: null,
      }),
    });

    expect([...(await loadChats())]).toEqual([
      ['a', 'Refund order 1234'],
      ['b', null],
    ]);
  });
});

describe('loadScheduleNames', () => {
  test('asks nothing when no notification names a schedule', async () => {
    stub = installBureauStub({});

    const names = await loadScheduleNames([]);

    expect(names.size).toBe(0);
    expect(stub.calls).toEqual([]);
  });

  test('names a schedule by its description, and only the schedules asked about', async () => {
    stub = installBureauStub({
      'bureau.schedules.list': () => ({
        schedules: [
          schedule('s-1', 'Daily summary', 'assistant'),
          schedule('s-2', 'Weekly digest', 'assistant'),
        ],
        nextOffset: null,
      }),
    });

    const names = await loadScheduleNames(['s-1']);

    expect([...names]).toEqual([['s-1', { name: 'Daily summary', identifier: false }]]);
  });

  test('falls back to the agent the schedule runs when it has no description', async () => {
    stub = installBureauStub({
      'bureau.schedules.list': () => ({
        schedules: [schedule('s-1', null, 'assistant')],
        nextOffset: null,
      }),
    });

    expect([...(await loadScheduleNames(['s-1']))]).toEqual([
      ['s-1', { name: 'assistant', identifier: true }],
    ]);
  });

  test('leaves out a schedule that is gone', async () => {
    stub = installBureauStub({
      'bureau.schedules.list': () => ({
        schedules: [schedule('s-1', 'Daily summary', 'assistant')],
        nextOffset: null,
      }),
    });

    const names = await loadScheduleNames(['s-gone']);

    expect(names.size).toBe(0);
  });
});
