/**
 * COR-2014 — a thread's snapshot says when each row was written, which model wrote each reply, and
 * when each tool call ran, all as the Bureau recorded them, so a client that reads the thread shows
 * those and not the moment it read it or the model the chat runs on now.
 */
import { TOOL_TIMING_METADATA_KEY } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import {
  appendMessages,
  CREATED_AT_METADATA_KEY,
  createConversationHistory,
  fromAGUIMessages,
  type MessageInput,
} from 'conversationalist';

import { REPLY_MODEL_METADATA_KEY } from '../file-agent-generate.ts';
import { snapshotMessages } from './ag-ui-messages.ts';

const USER_AT = '2026-11-02T16:41:00.000Z';
const CALL_AT = '2026-11-02T16:41:04.000Z';
const RESULT_AT = '2026-11-02T16:41:05.000Z';
const REPLY_AT = '2026-11-02T16:42:00.000Z';
const TIMING = { startedAt: '2026-11-02T16:41:04.100Z', endedAt: '2026-11-02T16:41:04.500Z' };
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5-5' };

function thread() {
  const rows: ReadonlyArray<readonly [MessageInput & { id: string }, string]> = [
    [{ id: 'u1', role: 'user', content: 'Please refund order 4471, it arrived damaged.' }, USER_AT],
    [
      {
        id: 'run-1:step:0:call:call-1',
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup-order', arguments: { orderId: '4471' } },
      },
      CALL_AT,
    ],
    [
      {
        id: 'run-1:step:0:result:call-1',
        role: 'tool-result',
        content: '',
        metadata: { [TOOL_TIMING_METADATA_KEY]: TIMING },
        toolResult: { callId: 'call-1', outcome: 'success', content: '$42.00, delivered Monday' },
      },
      RESULT_AT,
    ],
    [
      {
        id: 'run-1:step:1',
        role: 'assistant',
        content: 'Order 4471 is $42.00.',
        metadata: { [REPLY_MODEL_METADATA_KEY]: SONNET },
      },
      REPLY_AT,
    ],
  ];
  return rows.reduce(
    (history, [input, at]) => appendMessages(history, input, { now: () => at }),
    createConversationHistory({ id: 'session-1' }),
  );
}

describe('a thread’s snapshot', () => {
  it('reads back with each row at the time the Bureau wrote it', () => {
    const read = fromAGUIMessages(snapshotMessages(thread()));
    expect(read.ids.map((id) => read.messages[id]?.createdAt)).toEqual([
      USER_AT,
      CALL_AT,
      RESULT_AT,
      REPLY_AT,
    ]);
    for (const id of read.ids) {
      expect(Object.hasOwn(read.messages[id]?.metadata ?? {}, CREATED_AT_METADATA_KEY)).toBe(false);
    }
  });

  it('carries the reply’s own model and the call’s start and end', () => {
    const read = fromAGUIMessages(snapshotMessages(thread()));
    const rows = read.ids.map((id) => read.messages[id]);
    expect(
      rows.find((row) => row?.role === 'assistant')?.metadata[REPLY_MODEL_METADATA_KEY],
    ).toEqual(SONNET);
    expect(
      rows.find((row) => row?.role === 'tool-result')?.metadata[TOOL_TIMING_METADATA_KEY],
    ).toEqual(TIMING);
  });
});
