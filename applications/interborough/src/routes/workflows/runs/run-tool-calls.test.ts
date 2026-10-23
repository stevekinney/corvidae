import { describe, expect, test } from 'bun:test';

import { toolCallsOfRun } from './run-tool-calls.ts';

const thread = [
  { id: 'u', role: 'user', content: 'Refund' },
  {
    id: 'run-1:step:0',
    role: 'assistant',
    toolCalls: [
      { id: 'c1', type: 'function', function: { name: 'lookup-order', arguments: '{"orderId":"o1"}' } },
    ],
  },
  {
    id: 'run-1:step:0:result:c1',
    role: 'tool',
    toolCallId: 'c1',
    metadata: {
      'conversationalist:toolResult': { outcome: 'success', content: { status: 'delivered' } },
    },
  },
  {
    id: 'run-1:step:1',
    role: 'assistant',
    toolCalls: [{ id: 'c2', type: 'function', function: { name: 'issue-refund', arguments: '{}' } }],
  },
  {
    id: 'run-1:step:1:result:c2',
    role: 'tool',
    toolCallId: 'c2',
    metadata: { 'conversationalist:toolResult': { outcome: 'action_required' } },
  },
  {
    id: 'run-2:step:0',
    role: 'assistant',
    toolCalls: [{ id: 'c3', type: 'function', function: { name: 'other', arguments: '{}' } }],
  },
];

describe('toolCallsOfRun', () => {
  test('lists the calls of the run alone, in order, with where each stands', () => {
    const calls = toolCallsOfRun('run-1', thread);
    expect(calls.map((entry) => [entry.name, entry.state])).toEqual([
      ['lookup-order', 'done'],
      ['issue-refund', 'needs-you'],
    ]);
    expect(calls[0]?.arguments).toEqual({ orderId: 'o1' });
    expect(calls[0]?.summary).toBe('status delivered');
  });

  test('a call with no result is running, and a failed one says why', () => {
    const calls = toolCallsOfRun('run-2', thread);
    expect(calls[0]?.state).toBe('running');
    const failed = toolCallsOfRun('run-1', [
      thread[1],
      {
        id: 'run-1:step:0:result:c1',
        role: 'tool',
        toolCallId: 'c1',
        metadata: {
          'conversationalist:toolResult': { outcome: 'error', error: { message: 'No such order' } },
        },
      },
    ]);
    expect([failed[0]?.state, failed[0]?.summary]).toEqual(['failed', 'No such order']);
  });
});
