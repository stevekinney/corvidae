import { describe, expect, test } from 'bun:test';
import {
  appendMessages,
  appendUserMessage,
  createConversationHistory as createConversation,
  redactMessageAtPosition,
} from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import type { ConversationHistory } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';

describe('conversation redaction', () => {
  test('redact message by position', () => {
    let c = createConversation();
    c = appendUserMessage(c, 'secret');
    c = redactMessageAtPosition(c, 0, '[REDACTED]');
    expect(getOrderedMessages(c)[0]!.content).toBe('[REDACTED]');
  });

  test('redaction preserves tool metadata by default', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'tool', arguments: { key: 'value' } },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: {
          callId: 'call-1',
          outcome: 'success',
          content: { ok: true },
        },
      },
    );

    c = redactMessageAtPosition(c, 0, { placeholder: '[MASKED]' });
    const toolUse = getOrderedMessages(c)[0]!;
    if (toolUse === undefined) throw new Error('expected tool call message');
    expect(toolUse.toolCall?.id).toBe('call-1');
    expect(toolUse.toolCall?.name).toBe('tool');
    expect(toolUse.toolCall?.arguments).toBe('[MASKED]');

    c = redactMessageAtPosition(c, 1, { placeholder: '[MASKED]' });
    const toolResult = getOrderedMessages(c)[1]!;
    if (toolResult === undefined) throw new Error('expected tool result message');
    expect(toolResult.toolResult?.callId).toBe('call-1');
    expect(toolResult.toolResult?.outcome).toBe('success');
    expect(toolResult.toolResult?.content).toBe('[MASKED]');
  });

  test('redaction accepts an environment argument for timestamps', () => {
    const env = { now: () => '2024-02-02T00:00:00.000Z' };
    let c = createConversation();
    c = appendUserMessage(c, 'secret');

    const redacted = redactMessageAtPosition(c, 0, env);
    expect(getOrderedMessages(redacted)[0]!.content).toBe('[REDACTED]');
    expect(redacted.updatedAt).toBe('2024-02-02T00:00:00.000Z');
  });

  test('redaction can clear tool metadata when requested', () => {
    let c = createConversation();
    c = appendMessages(c, {
      role: 'tool-call',
      content: '',
      toolCall: { id: 'call-1', name: 'tool', arguments: {} },
    });

    c = redactMessageAtPosition(c, 0, { clearToolMetadata: true });
    const message = getOrderedMessages(c)[0]!;
    if (message === undefined) throw new Error('expected message');
    expect(message.toolCall).toBeUndefined();
    expect(message.toolResult).toBeUndefined();
  });

  test('redact out of range throws', () => {
    const c = createConversation();
    expect(() => redactMessageAtPosition(c, 0)).toThrow(ConversationalistError);
  });

  test('redact throws when the message id is missing', () => {
    const base = createConversation();
    const broken: ConversationHistory = {
      ...base,
      ids: ['missing'],
      messages: {},
    };
    expect(() => redactMessageAtPosition(broken, 0)).toThrow(ConversationalistError);
  });
});
