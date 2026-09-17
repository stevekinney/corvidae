import { describe, expect, it } from 'bun:test';

import {
  appendMessages,
  createConversationHistory,
  replaceToolResult,
  updateMessage,
  validateConversationHistoryIntegrity,
} from '../src/conversation';
import { redactPii } from '../src/plugins/pii-redaction';
import type { ConversationHistory, JSONValue, MessagePlugin, ToolResult } from '../src/types';

const environment = {
  now: () => '2026-08-18T12:00:00.000Z',
  randomId: (() => {
    let nextId = 0;
    return () => `message-${++nextId}`;
  })(),
};

const expectValid = (history: ConversationHistory): void => {
  expect(validateConversationHistoryIntegrity(history)).toEqual([]);
};

const annotateSuccessfulResult: MessagePlugin = (input) => {
  const metadata: Record<string, JSONValue> =
    input.toolResult?.outcome === 'success' ? { reviewed: true } : { actionRequired: true };
  return { ...input, metadata };
};
const markProcessedAndClearBlockedResult: MessagePlugin = (input) => ({
  ...input,
  metadata: { ...input.metadata, processed: true },
  toolResult:
    input.toolResult && (input.metadata?.['processed'] === true || input.content === 'Blocked')
      ? { ...input.toolResult, content: null }
      : input.toolResult,
});

describe('core', () => {
  it('replaces the result for a tool-call identifier without mutating the input result', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: { accountId: 'account-1' } },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      environment,
    );
    const resultMessageId = history.ids[1]!;
    const originalMessage = history.messages[resultMessageId]!;
    const replacement: ToolResult = {
      callId: 'call-1',
      outcome: 'success',
      content: { nested: { status: 'active' } },
    };
    const originalReplacement = structuredClone(replacement);

    const updated = replaceToolResult(history, 'call-1', replacement, environment);

    expect(updated.messages[resultMessageId]!).not.toBe(originalMessage);
    expect(updated.messages[resultMessageId]!).toMatchObject({
      id: originalMessage.id,
      position: originalMessage.position,
      createdAt: originalMessage.createdAt,
      toolResult: replacement,
    });
    expect(history.messages[resultMessageId]!).toBe(originalMessage);
    expect(replacement).toEqual(originalReplacement);
    expect(updated.messages[resultMessageId]?.toolResult).not.toBe(replacement);
    expectValid(updated);
  });

  it('returns the original history for an unknown tool-call identifier', () => {
    const history = createConversationHistory({}, environment);
    const replacement: ToolResult = {
      callId: 'missing',
      outcome: 'success',
      content: null,
    };

    expect(replaceToolResult(history, 'missing', replacement, environment)).toBe(history);
  });

  it('runs message plugins over replacement tool results', () => {
    const pluginEnvironment = { ...environment, plugins: [redactPii] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      pluginEnvironment,
    );

    const updated = replaceToolResult(
      history,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: { email: 'user@example.com' } },
      pluginEnvironment,
    );

    expect(updated.messages[history.ids[1]!]?.toolResult?.content).toEqual({
      email: '[EMAIL_REDACTED]',
    });
    expect(history.messages[history.ids[1]!]?.toolResult?.content).toBeNull();
    expectValid(updated);
  });

  it('preserves cross-field plugin transformations caused by a replacement tool result', () => {
    const pluginEnvironment = { ...environment, plugins: [annotateSuccessfulResult] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      pluginEnvironment,
    );
    const resultMessageId = history.ids[1]!;

    const updated = replaceToolResult(
      history,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: null },
      pluginEnvironment,
    );

    expect(history.messages[resultMessageId]?.metadata).toEqual({ actionRequired: true });
    expect(updated.messages[resultMessageId]?.metadata).toEqual({ reviewed: true });
    expectValid(updated);
  });

  it('preserves masked plugin transformations to a tool-result payload', () => {
    const pluginEnvironment = { ...environment, plugins: [markProcessedAndClearBlockedResult] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: 'Allowed',
        toolResult: { callId: 'call-1', outcome: 'success', content: { secret: 'value' } },
      },
      pluginEnvironment,
    );
    const resultMessageId = history.ids[1]!;

    const updated = updateMessage(
      history,
      resultMessageId,
      { content: 'Blocked' },
      pluginEnvironment,
    );

    expect(history.messages[resultMessageId]?.toolResult?.content).toEqual({ secret: 'value' });
    expect(updated.messages[resultMessageId]?.toolResult?.content).toBeNull();
    expect(updated.messages[resultMessageId]?.toolResult?.callId).toBe('call-1');
    expectValid(updated);
  });
});
