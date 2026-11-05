/**
 * A row's recorded time across AG-UI (COR-2014): export carries each row's `createdAt` when asked,
 * import reads it back as the row's time instead of the moment of the import, and the entry never
 * reaches the imported row's metadata.
 */
import { MessageSchema } from '@ag-ui/core/schemas';
import { describe, expect, it } from 'bun:test';

import { CREATED_AT_METADATA_KEY } from '../src/adapters/ag-ui/created-at';
import { fromAGUIMessages, mergeAGUIMessages } from '../src/adapters/ag-ui/inbound';
import { toAGUIMessages } from '../src/adapters/ag-ui/outbound';
import type { AGUIMessage } from '../src/adapters/ag-ui/types';
import { appendMessages, createConversationHistory } from '../src/conversation/index';
import type { MessageInput } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';
import { testEnvironment } from './adapter-test-fixtures';

/** A conversation whose rows were each written at the time beside them. */
function writtenAt(...rows: ReadonlyArray<readonly [MessageInput, string]>) {
  return rows.reduce(
    (conversation, [input, at]) =>
      appendMessages(conversation, input, { ...testEnvironment, now: () => at }),
    createConversationHistory({ id: 'ag-ui' }, testEnvironment),
  );
}

const USER_AT = '2026-11-02T16:41:00.000Z';
const CALL_AT = '2026-11-02T16:41:05.000Z';
const RESULT_AT = '2026-11-02T16:41:05.400Z';
const REPLY_AT = '2026-11-02T16:42:00.000Z';

function refundThread() {
  return writtenAt(
    [{ role: 'user', content: 'Please refund order 4471, it arrived damaged.' }, USER_AT],
    [
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup-order', arguments: { orderId: '4471' } },
      },
      CALL_AT,
    ],
    [
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: '$42.00' },
      },
      RESULT_AT,
    ],
    [{ role: 'assistant', content: 'Order 4471 is $42.00.', metadata: { kept: true } }, REPLY_AT],
  );
}

describe('AG-UI adapter: recorded times', () => {
  it('leaves the time out of an export that does not ask for it', () => {
    const messages = toAGUIMessages(refundThread());
    expect(JSON.stringify(messages)).not.toContain(CREATED_AT_METADATA_KEY);
  });

  it('carries every row’s time on the message, and a call’s on the call, when asked', () => {
    const messages = toAGUIMessages(refundThread(), { createdAt: true });
    for (const message of messages) expect(MessageSchema.safeParse(message).success).toBe(true);
    const [user, call, result, reply] = messages as [
      AGUIMessage,
      AGUIMessage & { toolCalls?: { metadata?: Record<string, unknown> }[] },
      AGUIMessage,
      AGUIMessage,
    ];
    expect(user.metadata?.[CREATED_AT_METADATA_KEY]).toBe(USER_AT);
    expect(call.toolCalls?.[0]?.metadata?.[CREATED_AT_METADATA_KEY]).toBe(CALL_AT);
    expect(result.metadata?.[CREATED_AT_METADATA_KEY]).toBe(RESULT_AT);
    expect(reply.metadata).toEqual({ kept: true, [CREATED_AT_METADATA_KEY]: REPLY_AT });
  });

  it('imports each row at its recorded time and keeps the entry out of its metadata', () => {
    const imported = fromAGUIMessages(toAGUIMessages(refundThread(), { createdAt: true }));
    const rows = getOrderedMessages(imported);
    expect(rows.map((row) => [row.role, row.createdAt])).toEqual([
      ['user', USER_AT],
      ['tool-call', CALL_AT],
      ['tool-result', RESULT_AT],
      ['assistant', REPLY_AT],
    ]);
    for (const row of rows)
      expect(Object.hasOwn(row.metadata, CREATED_AT_METADATA_KEY)).toBe(false);
    expect(rows.at(-1)?.metadata).toEqual({ kept: true });
  });

  it('gives each of a message’s calls its own time', () => {
    const imported = fromAGUIMessages([
      {
        id: 'a1',
        role: 'assistant',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup-order', arguments: '{}' },
            metadata: { [CREATED_AT_METADATA_KEY]: CALL_AT },
          },
          {
            id: 'call-2',
            type: 'function',
            function: { name: 'lookup-order', arguments: '{}' },
            metadata: { [CREATED_AT_METADATA_KEY]: RESULT_AT },
          },
        ],
      },
    ]);
    expect(getOrderedMessages(imported).map((row) => row.createdAt)).toEqual([CALL_AT, RESULT_AT]);
  });

  it('stamps a message with no recorded time, or one that is not a date, at the import', () => {
    const merged = mergeAGUIMessages(createConversationHistory({ id: 'ag-ui' }, testEnvironment), [
      { id: 'u1', role: 'user', content: 'Hello', metadata: { [CREATED_AT_METADATA_KEY]: 'soon' } },
    ]);
    const [row] = getOrderedMessages(merged);
    expect(row?.createdAt).not.toBe('soon');
    expect(Number.isFinite(Date.parse(row?.createdAt ?? ''))).toBe(true);
    expect(row?.metadata).toEqual({});
  });
});
