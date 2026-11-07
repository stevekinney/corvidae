/**
 * The remote calls Settings › A2A lists, read from the audit trail (COR-2009): only `a2a.call`
 * records, the newest ten inside the window, newest first.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  callOf,
  getRecentCalls,
  RECENT_CALL_COUNT,
  RECENT_CALL_WINDOW_MILLISECONDS,
} from './a2a-calls.ts';
import type { AuditRecord } from './bureau-audit.ts';
import { installBureauStub, type BureauStub } from './bureau-stub.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

const NOW = Date.parse('2026-11-05T12:00:00.000Z');

function record(index: number, detail: AuditRecord['detail'] = null): AuditRecord {
  return {
    sequence: index,
    timestamp: new Date(NOW - (100 - index) * 60_000).toISOString(),
    type: 'a2a.call',
    resource: `task-${index}`,
    principal: 'api-key:alice',
    detail: detail ?? { agentName: 'assistant', taskId: `task-${index}` },
  };
}

describe('the call an a2a.call record describes', () => {
  test('is the agent that answered, the task, when, and who made it', () => {
    expect(
      callOf({
        ...record(1),
        detail: { agentName: 'tool-runner', taskId: 'task-1', callerName: 'planner' },
      }),
    ).toEqual({
      taskId: 'task-1',
      at: Date.parse(record(1).timestamp),
      callerName: 'planner',
      principal: 'api-key:alice',
      agent: 'tool-runner',
    });
  });

  test('leaves out a caller that gave no name, and a record that names no agent', () => {
    expect(callOf(record(2))?.callerName).toBeUndefined();
    expect(callOf({ ...record(3), detail: { taskId: 'task-3' } })).toBeUndefined();
    expect(callOf({ ...record(4), detail: null })).toBeUndefined();
    expect(callOf({ ...record(5), timestamp: 'not a time' })).toBeUndefined();
  });
});

describe('the recent calls', () => {
  test('are the newest ten of the pages the trail answers, newest first, within the window', async () => {
    const pages = [
      { records: Array.from({ length: 8 }, (_, index) => record(index)), nextCursor: 'two' },
      { records: Array.from({ length: 8 }, (_, index) => record(index + 8)), nextCursor: null },
    ];
    const asked: Record<string, unknown>[] = [];
    stub = installBureauStub({
      'bureau.audit.query': (params) => {
        asked.push(params);
        return pages[asked.length - 1];
      },
    });

    const calls = await getRecentCalls({ now: NOW });

    expect(calls).toHaveLength(RECENT_CALL_COUNT);
    expect(calls.map((call) => call.taskId)).toEqual(
      Array.from({ length: RECENT_CALL_COUNT }, (_, index) => `task-${15 - index}`),
    );
    expect(asked[0]).toMatchObject({
      type: 'a2a.call',
      since: NOW - RECENT_CALL_WINDOW_MILLISECONDS,
    });
    expect(asked[1]).toMatchObject({ cursor: 'two' });
  });

  test('are none when the trail keeps none', async () => {
    stub = installBureauStub({ 'bureau.audit.query': () => ({ records: [], nextCursor: null }) });

    expect(await getRecentCalls({ now: NOW })).toEqual([]);
  });
});
