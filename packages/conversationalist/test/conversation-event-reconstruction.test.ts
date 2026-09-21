import { describe, expect, test } from 'bun:test';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { getOrderedMessages } from '../src/utilities/message-store';

/**
 * C2 — Reconstructing a ConversationHistory from an append-only event log
 *
 * This pattern demonstrates how to rebuild a ConversationHistory from an
 * external storage system that stores conversation events as an ordered list
 * of rows (e.g. a database table, a Weft log, or a JSONL file).
 *
 * Each row is a MessageInput that can be passed directly to appendMessages.
 * Tool call/result pairing is preserved automatically by the conversation
 * helpers — the row order in the log is sufficient to reconstruct the history.
 *
 * @example
 * ```ts
 * import { appendMessages, createConversationHistory } from 'conversationalist';
 *
 * // Rows loaded from external storage in insertion order
 * const rows: MessageInput[] = await db.query(
 *   'SELECT role, content, tool_call, tool_result FROM messages WHERE conversation_id = ? ORDER BY position ASC',
 *   [conversationId],
 * );
 *
 * const history = rows.reduce(
 *   (conversation, row) => appendMessages(conversation, row),
 *   createConversationHistory({ id: conversationId }),
 * );
 * ```
 */
describe('C2 — Reconstructing ConversationHistory from an append-only event log', () => {
  const testEnvironment = {
    now: () => '2024-01-01T00:00:00.000Z',
    randomId: (() => {
      let counter = 0;
      return () => `event-${++counter}`;
    })(),
  };

  test('reconstructs message order and content from event rows', () => {
    // Simulate event rows as would be read from a database in insertion order
    const eventRows = [
      { role: 'system' as const, content: 'You are a helpful assistant.' },
      { role: 'user' as const, content: 'Hello there!' },
      { role: 'assistant' as const, content: 'Hi! How can I help you today?' },
      { role: 'user' as const, content: 'What is 2 + 2?' },
      { role: 'assistant' as const, content: 'The answer is 4.' },
    ];

    // Reconstruct the history by reducing over the event rows
    const history = eventRows.reduce(
      (conversation, row) => appendMessages(conversation, row, testEnvironment),
      createConversation({ id: 'conv-from-log' }, testEnvironment),
    );

    const messages = getOrderedMessages(history);
    expect(messages).toHaveLength(5);

    // Message order is preserved
    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);

    // Content is preserved
    expect(messages[0]?.content).toBe('You are a helpful assistant.');
    expect(messages[1]?.content).toBe('Hello there!');
    expect(messages[4]?.content).toBe('The answer is 4.');
  });

  test('preserves tool-call/tool-result pairing through a round-trip', () => {
    // Simulate event rows including tool interactions
    const CALL_ID = 'tool-call-abc-123';

    const eventRows = [
      { role: 'user' as const, content: 'What is the weather in New York?' },
      {
        role: 'tool-call' as const,
        content: '',
        toolCall: { id: CALL_ID, name: 'get_weather', arguments: { city: 'New York' } },
      },
      {
        role: 'tool-result' as const,
        content: '',
        toolResult: {
          callId: CALL_ID,
          outcome: 'success' as const,
          content: { temperature: 68, unit: 'F', description: 'Partly cloudy' },
        },
      },
      { role: 'assistant' as const, content: 'The weather in New York is 68°F and partly cloudy.' },
    ];

    const history = eventRows.reduce(
      (conversation, row) => appendMessages(conversation, row, testEnvironment),
      createConversation({ id: 'conv-with-tools' }, testEnvironment),
    );

    const messages = getOrderedMessages(history);
    expect(messages).toHaveLength(4);

    // Tool-call/tool-result pairing is intact
    const toolCallMsg = messages.find((m) => m.role === 'tool-call');
    const toolResultMsg = messages.find((m) => m.role === 'tool-result');
    expect(toolCallMsg?.toolCall?.id).toBe(CALL_ID);
    expect(toolResultMsg?.toolResult?.callId).toBe(CALL_ID);
    expect(toolResultMsg?.toolResult?.outcome).toBe('success');
  });
});
