import type { ConversationHistory } from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_DENIAL,
  DENIED_CODE,
  interruptedWords,
  keyInput,
  railCall,
  toolDisplayName,
  toolGroups,
  type ToolInfo,
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

  test('a failed call keeps the tool’s own error for its panel: the message, the code and whether trying again can work', () => {
    const { groups } = toolGroups(
      conversation(
        call('s0', 'c1', 'send-email'),
        row({
          id: 's0:r',
          role: 'tool-result',
          toolResult: {
            callId: 'c1',
            outcome: 'error',
            content: 'SMTP timeout after 10s',
            error: {
              message: 'SMTP timeout after 10s',
              code: 'smtp-timeout',
              category: 'timeout',
              retryable: true,
            },
          },
        }),
        call('s1', 'c2', 'lookup-order'),
        result('s1:r', 'c2', 'success', { status: 'delivered' }),
      ),
    );
    const [failed, fine] = groups.get('s0')?.entries ?? [];
    expect(failed?.failure).toEqual({
      message: 'SMTP timeout after 10s',
      code: 'smtp-timeout',
      retryable: true,
    });
    expect(fine?.failure).toBeUndefined();
  });

  test('a message between two tool rows ends the group', () => {
    const { groups } = toolGroups(
      conversation(call('s0', 'c1', 'a'), row({ id: 'a1', content: 'Hm.' }), call('s1', 'c2', 'b')),
    );
    expect([...groups.keys()]).toEqual(['s0', 's1']);
  });
});

describe('a call of a failed attempt that Retry kept (B06, row 20b)', () => {
  test('reads as interrupted while the new turn’s run is going, and the new turn’s call as running', () => {
    const { groups } = toolGroups(
      conversation(
        row({ id: 'u1', role: 'user', content: 'Refund it' }),
        call('s0', 'c1', 'issue-refund'),
        row({ id: 'u2', role: 'user', content: 'Refund it' }),
        call('s1', 'c2', 'issue-refund'),
      ),
      { runActive: true },
    );
    expect(groups.get('s0')?.entries.map((entry) => entry.state)).toEqual(['interrupted']);
    expect(groups.get('s1')?.entries.map((entry) => entry.state)).toEqual(['running']);
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

describe('a call the run ended on', () => {
  const ended = conversation(
    row({ id: 'u1', role: 'user', content: 'Refund it' }),
    call('s0', 'c1', 'issue-refund', { orderId: 4471, reason: 'Arrived damaged' }),
  );
  const tools = new Map<string, ToolInfo>([
    ['issue-refund', { title: 'Issue refund', tier: 'dangerous' }],
  ]);

  test('is running while the run goes, and interrupted once nothing is working on it', () => {
    const live = toolGroups(ended, { runActive: true, tools }).groups.get('s0')?.entries[0];
    const over = toolGroups(ended, { runActive: false, tools }).groups.get('s0')?.entries[0];
    expect(live?.state).toBe('running');
    expect(over?.state).toBe('interrupted');
  });

  test('keeps the key input, the tool’s name for a person and what it may do', () => {
    const entry = toolGroups(ended, { runActive: false, tools }).groups.get('s0')?.entries[0];
    expect(entry).toMatchObject({ title: 'Issue refund', tier: 'dangerous', input: '4471' });
  });

  test('says it may have run for a tool that changes things or that nothing classifies, and did not finish for one that only reads', () => {
    expect(interruptedWords({ tier: 'mutating' })).toBe('Interrupted · may have run');
    expect(interruptedWords({ tier: 'dangerous' })).toBe('Interrupted · may have run');
    expect(interruptedWords({ tier: null })).toBe('Interrupted · may have run');
    expect(interruptedWords({ tier: undefined })).toBe('Interrupted · may have run');
    expect(interruptedWords({ tier: 'read-only' })).toBe('Interrupted · didn’t finish');
  });

  test('is a rail row that never carries an arrow, a result or a green dot', () => {
    const entry = toolGroups(ended, { runActive: false, tools }).groups.get('s0')!.entries[0]!;
    expect(railCall(entry, false)).toMatchObject({
      status: 'interrupted',
      name: 'Issue refund',
      identifier: 'issue-refund',
      input: '4471',
      result: 'Interrupted · may have run',
    });
  });

  test('a call that has its answer is never interrupted, whether or not the run still goes', () => {
    const answered = conversation(
      call('s0', 'c1', 'lookup-order', { orderId: 'o1' }),
      result('s0:r', 'c1', 'success', { status: 'delivered' }),
    );
    expect(toolGroups(answered, { runActive: false }).groups.get('s0')?.entries[0]?.state).toBe(
      'done',
    );
  });
});

describe('how a call is named', () => {
  test('the first scalar it was given is its key input', () => {
    expect(keyInput({ orderId: 4471, reason: 'x' })).toBe('4471');
    expect(keyInput({ nested: { a: 1 }, name: 'Parcelly' })).toBe('Parcelly');
    expect(keyInput('  multi\nline  ')).toBe('multi line');
    expect(keyInput({})).toBe('');
    expect(keyInput(undefined)).toBe('');
  });

  test('a tool with no title reads as its identifier in words', () => {
    expect(toolDisplayName('lookup-order')).toBe('Lookup order');
    expect(toolDisplayName('issue_refund', null)).toBe('Issue refund');
    expect(toolDisplayName('lookup-order', 'Find an order')).toBe('Find an order');
    expect(toolDisplayName('', null)).toBe('');
  });
});
