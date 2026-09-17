import { describe, expect, it } from 'bun:test';

import {
  appendUnsafeMessage,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import {
  appendStreamingMessage,
  appendUnsafeStreamingMessage,
  finalizeStreamingMessage,
  finalizeUnsafeStreamingMessage,
  isStreamingMessage,
  updateUnsafeStreamingMessage,
} from '../src/streaming';
import type { ConversationHistory as Conversation, Message } from '../src/types';

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `test-id-${++counter}`;
  })(),
};

describe('appendStreamingMessage', () => {
  it('creates a new streaming message', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    expect(messageId).toMatch(/^test-id-\d+$/);
    expect(conversation.ids).toHaveLength(1);
    expect(getOrderedMessages(conversation)[0]?.role).toBe('assistant');
    expect(getOrderedMessages(conversation)[0]?.content).toBe('');
  });

  it('marks message as streaming via metadata', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation } = appendStreamingMessage(conv, 'assistant', undefined, testEnvironment);

    expect(isStreamingMessage(getOrderedMessages(conversation)[0]!)).toBe(true);
  });

  it('preserves custom metadata', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation } = appendStreamingMessage(
      conv,
      'assistant',
      { custom: 'value' },
      testEnvironment,
    );

    expect(getOrderedMessages(conversation)[0]?.metadata['custom']).toBe('value');
  });
});

describe('unsafe streaming primitives', () => {
  it('updates and finalizes streaming messages on render-side conversations with orphan tool-results', () => {
    const withApprovalPlaceholder = appendUnsafeMessage(
      createConversation({ id: 'test' }, testEnvironment),
      {
        role: 'tool-result',
        content: 'Approval required: shell.exec',
        toolResult: {
          callId: 'apr-1',
          outcome: 'action_required',
          content: 'Waiting for approval',
        },
      },
      testEnvironment,
    );

    try {
      appendStreamingMessage(withApprovalPlaceholder, 'assistant', undefined, testEnvironment);
      throw new Error('Expected appendStreamingMessage to reject the orphan tool-result');
    } catch (error) {
      if (!(error instanceof ConversationalistError))
        throw new Error('unexpected error', { cause: error });
      expect(error.code).toBe('error:integrity');
      const issues = error.context?.['issues'];
      if (!Array.isArray(issues)) throw new Error('expected integrity issues', { cause: error });
      expect(
        issues.some(
          (issue) =>
            typeof issue === 'object' &&
            issue !== null &&
            'code' in issue &&
            issue.code === 'integrity:orphan-tool-result',
        ),
      ).toBe(true);
    }

    const { conversation, messageId } = appendUnsafeStreamingMessage(
      withApprovalPlaceholder,
      'assistant',
      undefined,
      testEnvironment,
    );
    const updated = updateUnsafeStreamingMessage(
      conversation,
      messageId,
      'Approved. Running command.',
      testEnvironment,
    );
    const finalized = finalizeUnsafeStreamingMessage(
      updated,
      messageId,
      { metadata: { rendered: true } },
      testEnvironment,
    );

    const streamingMessage = finalized.messages[messageId];
    expect(streamingMessage?.content).toBe('Approved. Running command.');
    expect(streamingMessage?.metadata['rendered']).toBe(true);
    expect(streamingMessage && isStreamingMessage(streamingMessage)).toBe(false);
  });

  it('still writes content to a finalized message, as the documented escape hatch', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const finalized = finalizeStreamingMessage(
      conversation,
      messageId,
      { tokenUsage: { prompt: 1, completion: 2, total: 3 } },
      testEnvironment,
    );
    const reprojected = updateUnsafeStreamingMessage(
      finalized,
      messageId,
      'Reprojected',
      testEnvironment,
    );

    expect(reprojected.messages[messageId]?.content).toBe('Reprojected');
    expect(reprojected.messages[messageId]?.tokenUsage).toEqual({
      prompt: 1,
      completion: 2,
      total: 3,
    });
  });
});
