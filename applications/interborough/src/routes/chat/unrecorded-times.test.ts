import { createConversationHistory } from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';
import { mergeAGUIMessages } from 'conversationalist';

import { NO_RECORDED_TIME, withoutImportTimes } from './unrecorded-times.ts';

const RECORDED = '2026-10-29T16:04:00.000Z';

const thread = [
  {
    id: 'user-1',
    role: 'user',
    content: 'Rename the billing tables',
    metadata: { 'conversationalist:createdAt': RECORDED },
  },
  { id: 'reply-1', role: 'assistant', content: 'I will start with the invoices table' },
  { id: 'system-1', role: 'system', content: 'You are an agent.' },
] as const;

function read() {
  const merged = mergeAGUIMessages(createConversationHistory({ id: 'thread' }), [
    ...thread,
  ] as never);
  return withoutImportTimes(merged, thread);
}

describe('a thread read with rows the Bureau recorded no time for', () => {
  test('keeps the recorded time of a row, and gives a row with none no time at all', () => {
    const conversation = read();

    expect(conversation.messages['user-1']?.createdAt).toBe(RECORDED);
    expect(conversation.messages['reply-1']?.createdAt).toBe(NO_RECORDED_TIME);
    expect(conversation.messages['system-1']?.createdAt).toBe(NO_RECORDED_TIME);
  });

  test('is the same conversation when every row recorded a time', () => {
    const stamped = thread.map((message) => ({
      ...message,
      metadata: { 'conversationalist:createdAt': RECORDED },
    }));
    const merged = mergeAGUIMessages(createConversationHistory({ id: 'thread' }), stamped);

    expect(withoutImportTimes(merged, stamped)).toBe(merged);
  });

  test('keeps the time a tool-only step recorded on its first call', () => {
    const step = [
      {
        id: 'step-1',
        role: 'assistant',
        toolCalls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup-order', arguments: '{}' },
            metadata: { 'conversationalist:createdAt': RECORDED },
          },
        ],
      },
    ];
    const merged = mergeAGUIMessages(createConversationHistory({ id: 'thread' }), step as never);

    expect(withoutImportTimes(merged, step).messages['step-1']?.createdAt).toBe(RECORDED);
  });
});
