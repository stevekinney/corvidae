import type { ConversationHistory } from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_DENIAL,
  DENIED_CODE,
  groupSummary,
  toolGroups,
  type ToolCallEntry,
} from './tool-activity.ts';

type Row = ConversationHistory['messages'][string];

const row = (value: Record<string, unknown>): Row =>
  ({ role: 'assistant', content: '', createdAt: '2026-10-23T00:00:00.000Z', ...value }) as Row;

function conversation(...rows: Row[]): ConversationHistory {
  return {
    schemaVersion: 4,
    id: 't',
    status: 'active',
    metadata: {},
    ids: rows.map((entry) => entry.id),
    messages: Object.fromEntries(rows.map((entry) => [entry.id, entry])),
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
  };
}

const call = (id: string, callId: string, name: string, args: unknown = {}) =>
  row({ id, role: 'tool-call', toolCall: { id: callId, name, arguments: args } });
const result = (id: string, callId: string, outcome: string, content: unknown = null) =>
  row({ id, role: 'tool-result', toolResult: { callId, outcome, content } });

describe('toolGroups', () => {
  const history = conversation(
    row({ id: 'u1', role: 'user', content: 'Refund it' }),
    call('s0', 'c1', 'lookup-order', { orderId: 'o1' }),
    result('s0:r', 'c1', 'success', { status: 'delivered' }),
    call('s1', 'c2', 'issue-refund', { orderId: 'o1' }),
    result('s1:r', 'c2', 'action_required'),
    row({ id: 'a1', content: 'Done.' }),
  );

  test('folds back-to-back tool rows into the group of the first, which renders it alone', () => {
    const { groups, absorbed } = toolGroups(history);
    expect([...groups.keys()]).toEqual(['s0']);
    expect(groups.get('s0')?.messageIds).toEqual(['s0', 's1']);
    expect([...absorbed]).toEqual(['s1']);
  });

  test('reads where each call stands from its result', () => {
    const entries = toolGroups(history).groups.get('s0')?.entries ?? [];
    expect(entries.map((entry) => [entry.name, entry.state])).toEqual([
      ['lookup-order', 'done'],
      ['issue-refund', 'needs-you'],
    ]);
    expect(entries[0]?.summary).toBe('status delivered');
  });

  test('a failed call says what failed: the error it carries, or else what its result holds', () => {
    const failedWith = row({
      id: 's1:r',
      role: 'tool-result',
      toolResult: {
        callId: 'c2',
        outcome: 'error',
        content: { status: 'ignored' },
        error: { message: 'The card was declined.' },
      },
    });
    const { groups } = toolGroups(
      conversation(
        call('s0', 'c1', 'lookup-order'),
        result('s0:r', 'c1', 'error', { status: 'unreachable' }),
        call('s1', 'c2', 'issue-refund'),
        failedWith,
        call('s2', 'c3', 'close-ticket'),
      ),
    );
    const entries = groups.get('s0')?.entries ?? [];
    expect(entries.map((entry) => [entry.name, entry.state, entry.summary])).toEqual([
      ['lookup-order', 'failed', 'status unreachable'],
      ['issue-refund', 'failed', 'The card was declined.'],
      ['close-ticket', 'running', ''],
    ]);
  });

  test('a message between two tool rows ends the group', () => {
    const { groups } = toolGroups(
      conversation(call('s0', 'c1', 'a'), row({ id: 'a1', content: 'Hm.' }), call('s1', 'c2', 'b')),
    );
    expect([...groups.keys()]).toEqual(['s0', 's1']);
  });
});

describe('a call the person refused', () => {
  const refused = (outcome: string, content: unknown, error?: Record<string, unknown>) =>
    toolGroups(
      conversation(
        call('s0', 'c1', 'issue-refund'),
        row({
          id: 's0:r',
          role: 'tool-result',
          toolResult: { callId: 'c1', outcome, content, ...(error === undefined ? {} : { error }) },
        }),
      ),
    ).groups.get('s0')?.entries[0];

  test('is Denied, not failed, when this page wrote the denial, with the reason beside it', () => {
    expect(
      refused('error', { decision: 'denied' }, { code: DENIED_CODE, message: 'Not today' }),
    ).toMatchObject({ state: 'denied', summary: 'Not today' });
    // A denial with no reason carries the page's own wording, which is not a reason.
    expect(
      refused('error', { decision: 'denied' }, { code: DENIED_CODE, message: DEFAULT_DENIAL }),
    ).toMatchObject({ state: 'denied', summary: '' });
  });

  test('is Denied when the Bureau wrote the denial or the rejection into the conversation', () => {
    expect(refused('error', 'Tool call denied')).toMatchObject({ state: 'denied', summary: '' });
    expect(refused('error', 'Tool call denied: too much')).toMatchObject({
      state: 'denied',
      summary: 'too much',
    });
    expect(refused('error', 'Tool call rejected: wrong order')).toMatchObject({
      state: 'denied',
      summary: 'wrong order',
    });
  });

  test('is still failed when the tool failed, even if its message talks of a denial', () => {
    expect(refused('error', 'Order service down')).toMatchObject({ state: 'failed' });
    expect(refused('error', 'The Tool call denied by the firewall')).toMatchObject({
      state: 'failed',
    });
    expect(refused('error', null, { code: 'timeout', message: 'Timed out' })).toMatchObject({
      state: 'failed',
      summary: 'Timed out',
    });
  });
});

describe('groupSummary', () => {
  const entry = (state: ToolCallEntry['state'], name = 't'): ToolCallEntry => ({
    callId: `${state}-${name}`,
    name,
    arguments: {},
    state,
    summary: '',
    result: undefined,
  });

  test('counts the tools, names each once with its count, and says how many need a decision or failed', () => {
    expect(groupSummary([entry('done'), entry('done')])).toBe('Used 2 tools · t ×2');
    expect(groupSummary([entry('done', 'a'), entry('needs-you', 'b')])).toBe(
      'Used 2 tools · a, b · 1 needs you',
    );
    expect(groupSummary([entry('failed', 'a'), entry('done', 'b'), entry('done', 'b')])).toBe(
      'Used 3 tools · a, b ×2 · 1 failed',
    );
    expect(groupSummary([entry('done', 'lookup-order')])).toBe('Used 1 tool · lookup-order');
  });

  test('lists the names in the order the calls were made, and a repeated name where it first appeared', () => {
    expect(
      groupSummary([
        entry('done', 'lookup-order'),
        entry('done', 'issue-refund'),
        entry('done', 'lookup-order'),
      ]),
    ).toBe('Used 3 tools · lookup-order ×2, issue-refund');
  });

  test('says denied for a refused call, and failed only for one that failed', () => {
    expect(groupSummary([entry('denied', 'a'), entry('done', 'b')])).toBe(
      'Used 2 tools · a, b · 1 denied',
    );
    expect(groupSummary([entry('denied', 'a'), entry('failed', 'b'), entry('done', 'c')])).toBe(
      'Used 3 tools · a, b, c · 1 failed · 1 denied',
    );
  });
});
